import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {bundle} from "@remotion/bundler";
import {renderMedia,selectComposition} from "@remotion/renderer";
import {config} from "./config.js";
import {db} from "./db.js";
import {AppError} from "./errors.js";
import {createSignedMediaUrl} from "./media-access.js";
import {getVideoAnalysisProject,videoAnalysisAssetDir,videoAnalysisOutputDir} from "./video-analysis-service.js";
import {videoAnalysisJobRegistry} from "./video-analysis-job-registry.js";
import {isVideoSourceMutationPending} from "./video-analysis-project-locks.js";
import {assertManagedVideoSourceUrl} from "./video-source-importer.js";
import {generateVideoTtsTrack} from "./video-tts.js";

let running=false;
let bundlePromise;
const insert=db.prepare(`INSERT INTO video_analysis_jobs(id,project_id,status,progress,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?)`);
const update=db.prepare(`UPDATE video_analysis_jobs SET status=?,progress=?,error=?,output_path=?,updated_at=? WHERE id=?`);
const get=db.prepare(`SELECT * FROM video_analysis_jobs WHERE id=?`);
const interruptedRows=db.prepare(`SELECT id,project_id,status,output_path FROM video_analysis_jobs WHERE status IN ('QUEUED','RENDERING')`);
const failInterrupted=db.prepare(`UPDATE video_analysis_jobs SET status='FAILED',error=?,output_path=NULL,updated_at=? WHERE id=? AND status IN ('QUEUED','RENDERING')`);

const publish=job=>({
 id:job.id,
 projectId:job.projectId,
 status:job.status,
 progress:job.progress,
 error:job.error||null,
 downloadUrl:job.status==="READY"?`/api/video-analysis/jobs/${job.id}/download`:null,
 createdAt:job.createdAt
});

function persist(job){
 update.run(job.status,job.progress,job.error||null,job.output||null,new Date().toISOString(),job.id);
}

function managedInterruptedOutput(value,jobId){
 const root=path.resolve(videoAnalysisOutputDir);
 const candidates=[value,path.join(root,`${jobId}.mp4`)];
 return [...new Set(candidates.filter(Boolean).map(candidate=>path.resolve(String(candidate))))]
  .filter(candidate=>candidate.startsWith(`${root}${path.sep}`));
}

export async function recoverInterruptedVideoAnalysisJobs({
 reason="Render bị gián đoạn vì server đã khởi động lại. Hãy tạo render job mới."
}={}){
 const rows=interruptedRows.all().filter(row=>!videoAnalysisJobRegistry.jobs.has(row.id));
 if(!rows.length)return{recovered:0,jobIds:[]};
 const now=new Date().toISOString();
 db.transaction(()=>{
  for(const row of rows)failInterrupted.run(reason,now,row.id);
 })();
 const paths=rows.flatMap(row=>managedInterruptedOutput(row.output_path,row.id));
 await Promise.all(paths.map(file=>fs.unlink(file).catch(()=>{})));
 return{recovered:rows.length,jobIds:rows.map(row=>row.id)};
}

const startupRecovery=await recoverInterruptedVideoAnalysisJobs();
if(startupRecovery.recovered){
 console.warn(`Recovered ${startupRecovery.recovered} interrupted video analysis job(s) after restart.`);
}

function decodeAudioDataUrl(dataUrl){
 const match=/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/su.exec(String(dataUrl||""));
 if(!match)throw new Error("TTS trả về dữ liệu âm thanh không hợp lệ.");
 const buffer=Buffer.from(match[2],"base64");
 if(!buffer.length)throw new Error("TTS trả về tệp âm thanh trống.");
 const mime=match[1].toLowerCase();
 const extension=mime.includes("mpeg")||mime.includes("mp3")?"mp3":mime.includes("ogg")?"ogg":mime.includes("webm")?"webm":"wav";
 return{buffer,extension};
}

async function materializeTtsTrack(jobId,dataUrl){
 const {buffer,extension}=decodeAudioDataUrl(dataUrl);
 const filename=`tts-${jobId}.${extension}`;
 const filePath=path.join(videoAnalysisAssetDir,filename);
 await fs.writeFile(filePath,buffer,{flag:"wx"});
 return{filePath,url:`${config.publicBaseUrl.replace(/\/$/u,"")}/video-analysis-assets/${encodeURIComponent(filename)}`};
}

async function work(job){
 let temporaryVoicePath="";
 try{
  job.status="RENDERING";
  job.progress=5;
  persist(job);
  const project=getVideoAnalysisProject(job.projectId);
  if(project.status!=="APPROVED")throw new Error("Script cần được duyệt trước khi render.");
  if(!project.source.url)throw new Error("Chưa có video nguồn.");
  const mediaScope={resourceType:"video-analysis",resourceId:project.id};
  const sourceVideoUrl=createSignedMediaUrl(assertManagedVideoSourceUrl(project.source.url),mediaScope);

  let voiceUrl="";
  let voiceDuration=0;
  if(project.settings.ttsEnabled){
   const fake={slides:project.script.segments.filter(segment=>segment.enabled).map(segment=>({
    headline:segment.subtitleText,
    body:segment.voiceOverText,
    video:{enabled:true,caption:segment.voiceOverText,speaker:segment.speaker}
   }))};
   const track=await generateVideoTtsTrack(fake,project.settings);
   if(!track?.dataUrl)throw new Error("TTS đã bật nhưng script không có nội dung giọng đọc.");
   const asset=await materializeTtsTrack(job.id,track.dataUrl);
   temporaryVoicePath=asset.filePath;
   voiceUrl=createSignedMediaUrl(asset.url,mediaScope);
   voiceDuration=Number(track.durationSeconds||0)/Math.max(.5,Number(project.settings.ttsSpeed||1));
  }

  const props={
   sourceVideoUrl,
   sourceDuration:Number(project.source.duration||0),
   segments:project.script.segments,
   settings:project.settings,
   voiceUrl,
   voiceDuration
  };
  const serveUrl=await(bundlePromise??=bundle({entryPoint:path.resolve("video/index.jsx")}));
  job.progress=20;
  persist(job);
  const composition=await selectComposition({
   serveUrl,
   id:"LanaAnalyzedVideo",
   inputProps:props,
   browserExecutable:process.env.REMOTION_BROWSER_EXECUTABLE||undefined
  });
  const output=path.join(videoAnalysisOutputDir,`${job.id}.mp4`);
  await renderMedia({
   composition,
   serveUrl,
   codec:"h264",
   audioCodec:"aac",
   outputLocation:output,
   inputProps:props,
   concurrency:1,
   crf:20,
   browserExecutable:process.env.REMOTION_BROWSER_EXECUTABLE||undefined,
   chromiumOptions:{disableWebSecurity:true},
   onProgress:({progress})=>{
    job.progress=20+Math.round(progress*78);
    persist(job);
   }
  });
  job.output=output;
  job.status="READY";
  job.progress=100;
  persist(job);
 }catch(error){
  job.status="FAILED";
  job.error=String(error.message||error).slice(0,500);
  persist(job);
 }finally{
  if(temporaryVoicePath)await fs.unlink(temporaryVoicePath).catch(()=>{});
 }
}

async function drain(){
 if(running)return;
 running=true;
 while(videoAnalysisJobRegistry.queue.length){
  const job=videoAnalysisJobRegistry.shift();
  if(job)await work(job);
 }
 running=false;
}

export function startVideoAnalysisJob(projectId){
 if(isVideoSourceMutationPending(projectId)){
  throw new AppError(
   "VIDEO_ANALYSIS_SOURCE_LOCKED",
   "Không thể bắt đầu render khi video nguồn đang được thay thế.",
   409
  );
 }
 getVideoAnalysisProject(projectId);
 const job={id:randomUUID(),projectId,status:"QUEUED",progress:0,createdAt:new Date().toISOString()};
 videoAnalysisJobRegistry.add(job);
 insert.run(job.id,projectId,job.status,0,job.createdAt,job.createdAt,new Date(Date.now()+7*864e5).toISOString());
 videoAnalysisJobRegistry.enqueue(job);
 queueMicrotask(drain);
 return publish(job);
}

export function getVideoAnalysisJob(id){
 const live=videoAnalysisJobRegistry.jobs.get(id);
 if(live)return publish(live);
 const row=get.get(id);
 if(!row)throw new AppError("VIDEO_ANALYSIS_JOB_NOT_FOUND","Không tìm thấy job.",404);
 return{
  id:row.id,
  projectId:row.project_id,
  status:row.status,
  progress:row.progress,
  error:row.error,
  downloadUrl:row.status==="READY"?`/api/video-analysis/jobs/${row.id}/download`:null,
  createdAt:row.created_at
 };
}

export function getVideoAnalysisFile(id){
 const live=videoAnalysisJobRegistry.jobs.get(id);
 const row=live||get.get(id);
 const output=live?.output||row?.output_path;
 const status=live?.status||row?.status;
 if(status!=="READY"||!output)throw new AppError("VIDEO_ANALYSIS_JOB_NOT_READY","Video chưa sẵn sàng.",409);
 return output;
}
