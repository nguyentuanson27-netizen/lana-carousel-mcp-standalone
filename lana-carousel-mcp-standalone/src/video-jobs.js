import path from "node:path";
import fs from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {bundle} from "@remotion/bundler";
import {renderMedia,selectComposition} from "@remotion/renderer";
import {config} from "./config.js";
import {AppError} from "./errors.js";
import {getProject} from "./service.js";
import {generateVideoTtsData} from "./video-tts.js";

const jobs=new Map(),queue=[];let running=false,bundlePromise;
const outputDir=path.resolve(path.dirname(config.databasePath),"video-renders");
const publicJob=j=>({id:j.id,projectId:j.projectId,status:j.status,progress:j.progress,error:j.error,createdAt:j.createdAt,completedAt:j.completedAt,downloadUrl:j.status==="READY"?`${config.publicBaseUrl}/api/video-render-jobs/${j.id}/download`:null});
const settings=p=>p.videoSettings||{};
function propsFor(project){
 const cfg=settings(project),preset={fashion:{motion:"zoom-in",transition:"fade",textAnimation:"block"},tiktok:{motion:"ken-burns",transition:"cut",textAnimation:"by-word"},minimal:{motion:"none",transition:"fade",textAnimation:"block"},editorial:{motion:"pan-left",transition:"fade",textAnimation:"by-line"}}[cfg.preset]||{},assetMap=new Map(project.assets.map(a=>[a.id,a]));
 let scenes=project.slides.map((slide,index)=>{
  const s=slide.video||{},ids=slide.selectedAssetIds?.length?slide.selectedAssetIds:[slide.selectedAssetId].filter(Boolean),asset=assetMap.get(ids[0]);
  let duration=Number(s.duration||cfg.defaultSceneDuration||3);
  if(cfg.beatSync&&cfg.bpm)duration=Math.max(.5,Math.round(duration/(60/cfg.bpm))*(60/cfg.bpm));
  return{id:slide.id,enabled:s.enabled!==false,order:Number(s.order??index),duration,motion:s.motion||cfg.motion||preset.motion||"zoom-in",transition:s.transition||cfg.transition||preset.transition||"fade",textAnimation:s.textAnimation||cfg.textAnimation||preset.textAnimation||"none",subtitles:s.subtitles??cfg.subtitles??false,caption:s.caption||slide.body,headline:slide.headline,body:slide.body,textLayers:slide.textLayers,imageUrl:asset?.publicUrl||""};
 }).sort((a,b)=>a.order-b.order).filter(s=>s.imageUrl);
 return{scenes,audioUrl:cfg.audioUrl||cfg.ttsAudioUrl||"",audioVolume:Number(cfg.audioVolume??.6),aspectRatio:cfg.aspectRatio||"vertical",fps:Number(cfg.fps||30)};
}
async function serveUrl(){bundlePromise??=bundle({entryPoint:path.resolve("video/index.jsx")});return bundlePromise;}
async function work(job){
 try{
  job.status="RENDERING";job.progress=5;await fs.mkdir(outputDir,{recursive:true});
  const project=getProject(job.projectId),inputProps=propsFor(project);if(project.videoSettings?.ttsEnabled)inputProps.audioUrl=await generateVideoTtsData(project,project.videoSettings.ttsVoice);if(!inputProps.scenes.length)throw new Error("Không có cảnh đã duyệt để render.");
  const url=await serveUrl();job.progress=20;
  const composition=await selectComposition({serveUrl:url,id:"LanaCarouselVideo",inputProps,browserExecutable:process.env.REMOTION_BROWSER_EXECUTABLE||undefined});
  const output=path.join(outputDir,`${job.id}.mp4`);
  await renderMedia({composition,serveUrl:url,codec:"h264",outputLocation:output,inputProps,concurrency:1,crf:20,chromiumOptions:{disableWebSecurity:true},onProgress:({progress})=>{job.progress=20+Math.round(progress*78);}});
  job.output=output;job.status="READY";job.progress=100;job.completedAt=new Date().toISOString();
 }catch(e){job.status="FAILED";job.error=e?.message||"Render video thất bại";job.completedAt=new Date().toISOString();}
}
async function drain(){if(running)return;running=true;while(queue.length)await work(queue.shift());running=false;}
export function startVideoRenderJob(projectId){const p=getProject(projectId);if(!p.videoEnabled)throw new AppError("VIDEO_NOT_ENABLED","Hãy bật video trước khi render.",409);const job={id:randomUUID(),projectId,status:"QUEUED",progress:0,createdAt:new Date().toISOString()};jobs.set(job.id,job);queue.push(job);queueMicrotask(drain);return publicJob(job);}
export function getVideoRenderJob(id){const j=jobs.get(id);if(!j)throw new AppError("VIDEO_JOB_NOT_FOUND","Không tìm thấy tác vụ video.",404);return publicJob(j);}
export function getVideoRenderFile(id){const j=jobs.get(id);if(!j||j.status!=="READY")throw new AppError("VIDEO_JOB_NOT_READY","Video chưa sẵn sàng.",409);return j.output;}
setInterval(async()=>{const cutoff=Date.now()-14*864e5;for(const[id,j]of jobs)if(new Date(j.createdAt).getTime()<cutoff){jobs.delete(id);if(j.output)await fs.unlink(j.output).catch(()=>{});}},3600e3).unref();
