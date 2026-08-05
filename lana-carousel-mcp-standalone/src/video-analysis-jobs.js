import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {bundle} from "@remotion/bundler";
import {renderMedia,selectComposition} from "@remotion/renderer";
import {config} from "./config.js";
import {db} from "./db.js";
import {AppError} from "./errors.js";
import {getVideoAnalysisProject,videoAnalysisAssetDir,videoAnalysisOutputDir} from "./video-analysis-service.js";
import {generateVideoTtsTrack} from "./video-tts.js";
const jobs=new Map(),queue=[];let running=false,bundlePromise;
const insert=db.prepare(`INSERT INTO video_analysis_jobs(id,project_id,status,progress,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?)`),update=db.prepare(`UPDATE video_analysis_jobs SET status=?,progress=?,error=?,output_path=?,updated_at=? WHERE id=?`),get=db.prepare(`SELECT * FROM video_analysis_jobs WHERE id=?`);
const publish=j=>({id:j.id,projectId:j.projectId,status:j.status,progress:j.progress,error:j.error||null,downloadUrl:j.status==="READY"?`/api/video-analysis/jobs/${j.id}/download`:null,createdAt:j.createdAt});
function persist(j){update.run(j.status,j.progress,j.error||null,j.output||null,new Date().toISOString(),j.id)}
function decodeAudioDataUrl(dataUrl){
 const match=/^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/su.exec(String(dataUrl||""));
 if(!match)throw new Error("TTS trả về dữ liệu âm thanh không hợp lệ.");
 const buffer=Buffer.from(match[2],"base64");
 if(!buffer.length)throw new Error("TTS trả về tệp âm thanh trống.");
 const mime=match[1].toLowerCase(),extension=mime.includes("mpeg")||mime.includes("mp3")?"mp3":mime.includes("ogg")?"ogg":mime.includes("webm")?"webm":"wav";
 return{buffer,extension};
}
async function materializeTtsTrack(jobId,dataUrl){
 const {buffer,extension}=decodeAudioDataUrl(dataUrl),filename=`tts-${jobId}.${extension}`,filePath=path.join(videoAnalysisAssetDir,filename);
 await fs.writeFile(filePath,buffer,{flag:"wx"});
 return{filePath,url:`${config.publicBaseUrl.replace(/\/$/u,"")}/video-analysis-assets/${encodeURIComponent(filename)}`};
}
async function work(j){let temporaryVoicePath="";try{j.status="RENDERING";j.progress=5;persist(j);const p=getVideoAnalysisProject(j.projectId);if(p.status!=="APPROVED")throw new Error("Script cần được duyệt trước khi render.");if(!p.source.url)throw new Error("Chưa có video nguồn.");let voiceUrl="",voiceDuration=0;if(p.settings.ttsEnabled){const fake={slides:p.script.segments.filter(s=>s.enabled).map(s=>({headline:s.subtitleText,body:s.voiceOverText,video:{enabled:true,caption:s.voiceOverText,speaker:s.speaker}}))};const track=await generateVideoTtsTrack(fake,p.settings);if(!track?.dataUrl)throw new Error("TTS đã bật nhưng script không có nội dung giọng đọc.");const asset=await materializeTtsTrack(j.id,track.dataUrl);temporaryVoicePath=asset.filePath;voiceUrl=asset.url;voiceDuration=Number(track.durationSeconds||0)/Math.max(.5,Number(p.settings.ttsSpeed||1));}const props={sourceVideoUrl:p.source.url,sourceDuration:Number(p.source.duration||0),segments:p.script.segments,settings:p.settings,voiceUrl,voiceDuration};const serveUrl=await(bundlePromise??=bundle({entryPoint:path.resolve("video/index.jsx")}));j.progress=20;persist(j);const composition=await selectComposition({serveUrl,id:"LanaAnalyzedVideo",inputProps:props,browserExecutable:process.env.REMOTION_BROWSER_EXECUTABLE||undefined});const output=path.join(videoAnalysisOutputDir,`${j.id}.mp4`);await renderMedia({composition,serveUrl,codec:"h264",audioCodec:"aac",outputLocation:output,inputProps:props,concurrency:1,crf:20,chromiumOptions:{disableWebSecurity:true},onProgress:({progress})=>{j.progress=20+Math.round(progress*78);persist(j)}});j.output=output;j.status="READY";j.progress=100;persist(j)}catch(e){j.status="FAILED";j.error=String(e.message||e).slice(0,500);persist(j)}finally{if(temporaryVoicePath)await fs.unlink(temporaryVoicePath).catch(()=>{})}}
async function drain(){if(running)return;running=true;while(queue.length)await work(queue.shift());running=false}
export function startVideoAnalysisJob(projectId){getVideoAnalysisProject(projectId);const j={id:randomUUID(),projectId,status:"QUEUED",progress:0,createdAt:new Date().toISOString()};jobs.set(j.id,j);insert.run(j.id,projectId,j.status,0,j.createdAt,j.createdAt,new Date(Date.now()+7*864e5).toISOString());queue.push(j);queueMicrotask(drain);return publish(j)}
export function getVideoAnalysisJob(id){const live=jobs.get(id);if(live)return publish(live);const r=get.get(id);if(!r)throw new AppError("VIDEO_ANALYSIS_JOB_NOT_FOUND","Không tìm thấy job.",404);return{id:r.id,projectId:r.project_id,status:r.status,progress:r.progress,error:r.error,downloadUrl:r.status==="READY"?`/api/video-analysis/jobs/${r.id}/download`:null,createdAt:r.created_at}}
export function getVideoAnalysisFile(id){const live=jobs.get(id),r=live||get.get(id);const output=live?.output||r?.output_path,status=live?.status||r?.status;if(status!=="READY"||!output)throw new AppError("VIDEO_ANALYSIS_JOB_NOT_READY","Video chưa sẵn sàng.",409);return output}
