import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {bundle} from "@remotion/bundler";
import {renderMedia,selectComposition} from "@remotion/renderer";
import {db} from "./db.js";
import {AppError} from "./errors.js";
import {createSignedMediaUrl} from "./media-access.js";
import {getVideoAnalysisProject,videoAnalysisOutputDir} from "./video-analysis-service.js";
import {videoAnalysisJobRegistry} from "./video-analysis-job-registry.js";
import {isVideoSourceMutationPending} from "./video-analysis-project-locks.js";
import {assertManagedVideoSourceUrl} from "./video-source-importer.js";
import {synthesizeCachedSpeech} from "./video-tts-cache.js";
export {wavDurationSeconds,mp3DurationSeconds} from "./video-audio-file.js";

let running=false;
let bundlePromise;
const TTS_CONCURRENCY=3;
const MAX_TTS_FIT_RATE=1.25;
const UNMEASURED_DURATION_HEADROOM=2;
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

// Không được ném lỗi ngay khi worker đầu tiên hỏng: các worker còn lại vẫn đang gọi TTS và
// vẫn sẽ ghi vào cache. Trả lỗi về trong lúc đó là bỏ mặc công việc còn dở chạy tiếp ngoài
// tầm kiểm soát của job. Dừng nhận việc mới, chờ tất cả dừng hẳn rồi mới báo lỗi.
export async function mapWithLimit(items,limit,run){
 const results=new Array(items.length);
 let cursor=0;
 let failure;
 const workers=Array.from({length:Math.max(1,Math.min(limit,items.length))},async()=>{
  while(cursor<items.length&&!failure){
   const current=cursor;
   cursor+=1;
   try{
    results[current]=await run(items[current],current);
   }catch(error){
    failure??=error;
   }
  }
 });
 await Promise.all(workers);
 if(failure)throw failure;
 return results;
}

// Mỗi đoạn được đọc riêng nên transcript không còn nhiều người nói:
// chọn thẳng giọng đã gán cho đoạn đó thay vì để Vertex tự chia vai.
function segmentVoiceSettings(settings,segment){
 return{
  ...settings,
  geminiMultiSpeaker:false,
  geminiSpeaker1Voice:segment.speaker==="speaker2"
   ?(settings.geminiSpeaker2Voice||"Puck")
   :(settings.geminiSpeaker1Voice||"Kore")
 };
}

async function synthesizeSegmentVoice({settings,segment}){
 const clip=await synthesizeCachedSpeech({
  text:segment.voiceOverText,
  settings:segmentVoiceSettings(settings,segment)
 });
 if(!clip)return null;
 // Nhánh Google trả MP3 kèm độ dài chỉ ước lượng theo số từ chứ không phải độ dài thật.
 // Phải phân biệt để bên dưới không cắt clip theo một con số đoán.
 const rawDuration=clip.measured?clip.duration:Number(clip.estimatedDuration||0);
 return rawDuration>0?{url:clip.url,rawDuration,measured:clip.measured}:null;
}

// Một track TTS liền mạch phát từ giây 0 sẽ lệch dần so với phụ đề, và độ lệch tích lũy
// tới cuối video. Mỗi đoạn phải là một clip riêng đặt đúng vào mốc thời gian của nó.
export function planVoiceTracks({segments,clips,ttsSpeed}){
 const speed=Math.max(.5,Number(ttsSpeed||1));
 const tracks=[];
 for(const [index,clip] of clips.entries()){
  if(!clip||!(Number(clip.rawDuration)>0))continue;
  const rawDuration=Number(clip.rawDuration);
  const start=Number(segments[index].start||0);
  // Khung an toàn kéo tới lúc đoạn kế bắt đầu đọc, kể cả khi giữa hai đoạn có khoảng trống.
  const nextStart=index+1<segments.length?Number(segments[index+1].start||0):Infinity;
  const window=Math.max(.1,nextStart-start);
  // Đọc tràn sang đoạn sau thì hai giọng chồng nhau, nên ép nhanh trong giới hạn
  // thay vì cắt cụt câu. Vượt quá giới hạn thì chấp nhận tràn còn hơn mất chữ.
  const playbackRate=speed*Math.min(MAX_TTS_FIT_RATE,Math.max(1,rawDuration/speed/window));
  tracks.push({
   id:segments[index].id||`voice-${index}`,
   url:clip.url,
   start,
   duration:rawDuration/playbackRate,
   // Chỉ cắt clip khi độ dài là số đo thật. Với độ dài ước lượng, cắt theo nó sẽ mất
   // phần cuối câu — trái đúng nguyên tắc thà đọc tràn còn hơn mất chữ.
   measured:clip.measured!==false,
   playbackRate
  });
 }
 return tracks;
}

// calculateMetadata chốt độ dài composition từ con số này, nên nó cũng là một điểm cắt:
// clip nào kết thúc sau mốc đó vẫn mất phần cuối câu dù <Sequence> không còn cắt nữa.
// Định dạng nào đo được thì mốc là chính xác; định dạng lạ chỉ có độ dài ước lượng nên
// phải chừa biên an toàn thay vì tin vào con số đoán.
export function voiceTracksDuration(tracks){
 return tracks.reduce((longest,track)=>Math.max(
  longest,
  Number(track.start||0)+Number(track.duration||0)*(track.measured===false?UNMEASURED_DURATION_HEADROOM:1)
 ),0);
}

export async function buildVoiceTracks({settings,segments,mediaScope}){
 const clips=await mapWithLimit(segments,TTS_CONCURRENCY,segment=>
  synthesizeSegmentVoice({settings,segment}));
 return planVoiceTracks({segments,clips,ttsSpeed:settings.ttsSpeed})
  .map(track=>({...track,url:createSignedMediaUrl(track.url,mediaScope)}));
}

async function work(job){
 try{
  job.status="RENDERING";
  job.progress=5;
  persist(job);
  const project=getVideoAnalysisProject(job.projectId);
  if(project.status!=="APPROVED")throw new Error("Script cần được duyệt trước khi render.");
  if(!project.source.url)throw new Error("Chưa có video nguồn.");
  const mediaScope={resourceType:"video-analysis",resourceId:project.id};
  const sourceVideoUrl=createSignedMediaUrl(assertManagedVideoSourceUrl(project.source.url),mediaScope);

  let voiceTracks=[];
  let voiceDuration=0;
  if(project.settings.ttsEnabled){
   voiceTracks=await buildVoiceTracks({
    settings:project.settings,
    segments:project.script.segments.filter(segment=>segment.enabled!==false),
    mediaScope
   });
   if(!voiceTracks.length)throw new Error("TTS đã bật nhưng script không có nội dung giọng đọc.");
   voiceDuration=voiceTracksDuration(voiceTracks);
  }

  const props={
   sourceVideoUrl,
   sourceDuration:Number(project.source.duration||0),
   segments:project.script.segments,
   settings:project.settings,
   voiceTracks,
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
