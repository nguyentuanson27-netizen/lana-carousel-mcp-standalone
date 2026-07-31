import path from "node:path";
import fs from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {bundle} from "@remotion/bundler";
import {renderMedia,selectComposition} from "@remotion/renderer";
import {config} from "./config.js";
import {AppError} from "./errors.js";
import {getProject} from "./service.js";
import {generateVideoTtsTrack} from "./video-tts.js";

const jobs=new Map(),queue=[];let running=false,bundlePromise;
const outputDir=path.resolve(path.dirname(config.databasePath),"video-renders"),videoRetentionMs=7*864e5;
const publicJob=j=>({id:j.id,projectId:j.projectId,status:j.status,progress:j.progress,error:j.error,createdAt:j.createdAt,completedAt:j.completedAt,expiresAt:new Date(new Date(j.createdAt).getTime()+videoRetentionMs).toISOString(),downloadUrl:j.status==="READY"?`${config.publicBaseUrl}/api/video-render-jobs/${j.id}/download`:null});
const settings=p=>p.videoSettings||{};
function propsFor(project){
 const cfg=settings(project),preset={fashion:{motion:"zoom-in",transition:"fade",textAnimation:"block"},tiktok:{motion:"ken-burns",transition:"cut",textAnimation:"by-word"},minimal:{motion:"none",transition:"fade",textAnimation:"block"},editorial:{motion:"pan-left",transition:"fade",textAnimation:"by-line"}}[cfg.preset]||{},assetMap=new Map(project.assets.map(a=>[a.id,a]));
 let scenes=project.slides.map((slide,index)=>{
  const s=slide.video||{},ids=slide.selectedAssetIds?.length?slide.selectedAssetIds:[slide.selectedAssetId].filter(Boolean),asset=assetMap.get(ids[0]);
  let duration=Number(s.duration||cfg.defaultSceneDuration||3);
  if(cfg.beatSync&&cfg.bpm)duration=Math.max(.5,Math.round(duration/(60/cfg.bpm))*(60/cfg.bpm));
  const layers=(slide.textLayers||[]).map((layer,layerIndex)=>({...layer,animation:s.layerAnimations?.[layer.id]||s.layerAnimations?.[String(layerIndex)]||layer.animation||s.textAnimation||cfg.textAnimation||preset.textAnimation||"none",animationDelay:Number(layer.animationDelay??layerIndex*(cfg.layerStagger??.12))}));
  return{id:slide.id,enabled:s.enabled!==false,order:Number(s.order??index),duration,motion:(s.motion==="ken-burns"&&cfg.smartKenBurns)?"smart-ken-burns":s.motion||cfg.motion||preset.motion||"zoom-in",transition:s.transition||cfg.transition||preset.transition||"fade",textAnimation:s.textAnimation||cfg.textAnimation||preset.textAnimation||"none",subtitles:s.subtitles??cfg.subtitles??false,subtitleStyle:s.subtitleStyle||cfg.subtitleStyle||"karaoke",subtitlePosition:Number(s.subtitlePosition??cfg.subtitlePosition??88),caption:s.caption||slide.body||slide.headline,headline:slide.headline,body:slide.body,textLayers:layers,imageUrl:asset?.publicUrl||"",focusX:Number(s.focusX??slide.cropX??50),focusY:Number(s.focusY??slide.cropY??50),kenBurnsIntensity:Number(s.kenBurnsIntensity??cfg.kenBurnsIntensity??.14)};
 }).sort((a,b)=>a.order-b.order).filter(s=>s.imageUrl);
 return{scenes,audioUrl:cfg.audioUrl||"",audioVolume:Number(cfg.audioVolume??.6),voiceUrl:"",voiceVolume:Number(cfg.ttsVolume??1),voicePlaybackRate:Number(cfg.ttsSpeed??1),aspectRatio:cfg.aspectRatio||"vertical",fps:Number(cfg.fps||30)};
}
async function validateAudioUrl(value){
 if(!value)return;
 let url;try{url=new URL(value);}catch{throw new Error("URL nhac nen khong hop le.");}
 if(/(^|\.)tiktok\.com$/iu.test(url.hostname)||/(^|\.)vm\.tiktok\.com$/iu.test(url.hostname)||/(^|\.)vt\.tiktok\.com$/iu.test(url.hostname))throw new Error("Khong the dung link trang TikTok lam nhac nen. Hay tai MP3 len hoac dung URL truc tiep den file media.");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
 try{const response=await fetch(url,{method:"GET",redirect:"follow",signal:controller.signal,headers:{"User-Agent":"Mozilla/5.0 LanaCarousel/2.3","Range":"bytes=0-1023","Accept":"audio/*,video/*;q=0.9,*/*;q=0.1"}}),type=(response.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();await response.body?.cancel().catch(()=>{});if(!response.ok)throw new Error("Khong tai duoc nhac nen (HTTP "+response.status+").");if(!type.startsWith("audio/")&&!type.startsWith("video/")&&type!=="application/octet-stream")throw new Error("URL nhac nen khong phai file media truc tiep ("+(type||"khong ro dinh dang")+").");}
 catch(error){if(error?.name==="AbortError")throw new Error("Nguon nhac nen phan hoi qua cham.");throw error;}finally{clearTimeout(timer);}
}
function friendlyVideoError(error){const message=String(error?.message||"Render video that bai");if(/Error while downloading|ffprobe|remotion-assets-dir|Command failed/iu.test(message))return "Khong doc duoc nhac nen. Hay tai MP3 len hoac dung URL truc tiep den MP3, M4A, WAV hay MP4.";return message.slice(0,500);}
async function serveUrl(){bundlePromise??=bundle({entryPoint:path.resolve("video/index.jsx")});return bundlePromise;}
async function work(job){
 try{
  job.status="RENDERING";job.progress=5;await fs.mkdir(outputDir,{recursive:true});
  const project=getProject(job.projectId),inputProps=propsFor(project);await validateAudioUrl(inputProps.audioUrl);if(project.videoSettings?.ttsEnabled){const track=await generateVideoTtsTrack(project,project.videoSettings);inputProps.voiceUrl=track.dataUrl;if(project.videoSettings.autoTiming!==false&&track.durationSeconds){const active=inputProps.scenes.filter(s=>s.enabled!==false),weights=active.map(s=>Math.max(1,String(s.caption||s.body||s.headline||"").replace(/\s+/gu,"").length)),totalWeight=weights.reduce((a,b)=>a+b,0),target=track.durationSeconds/Math.max(.5,inputProps.voicePlaybackRate);active.forEach((scene,i)=>{scene.duration=Math.max(.8,Math.min(15,target*weights[i]/totalWeight));});}}if(!inputProps.scenes.length)throw new Error("Không có cảnh đã duyệt để render.");
  const url=await serveUrl();job.progress=20;
  const composition=await selectComposition({serveUrl:url,id:"LanaCarouselVideo",inputProps,browserExecutable:process.env.REMOTION_BROWSER_EXECUTABLE||undefined});
  const output=path.join(outputDir,`${job.id}.mp4`);
  await renderMedia({composition,serveUrl:url,codec:"h264",outputLocation:output,inputProps,concurrency:1,crf:20,chromiumOptions:{disableWebSecurity:true},onProgress:({progress})=>{job.progress=20+Math.round(progress*78);}});
  job.output=output;job.status="READY";job.progress=100;job.completedAt=new Date().toISOString();
 }catch(e){job.status="FAILED";job.error=friendlyVideoError(e);job.completedAt=new Date().toISOString();}
}
async function drain(){if(running)return;running=true;while(queue.length)await work(queue.shift());running=false;}
export function startVideoRenderJob(projectId){const p=getProject(projectId);if(!p.videoEnabled)throw new AppError("VIDEO_NOT_ENABLED","Hãy bật video trước khi render.",409);const job={id:randomUUID(),projectId,status:"QUEUED",progress:0,createdAt:new Date().toISOString()};jobs.set(job.id,job);queue.push(job);queueMicrotask(drain);return publicJob(job);}
export function getVideoRenderJob(id){const j=jobs.get(id);if(!j)throw new AppError("VIDEO_JOB_NOT_FOUND","Không tìm thấy tác vụ video.",404);return publicJob(j);}
export function getVideoRenderFile(id){const j=jobs.get(id);if(!j||j.status!=="READY")throw new AppError("VIDEO_JOB_NOT_READY","Video chua san sang.",409);return j.output;}
export async function deleteVideoRenderJob(id){const j=jobs.get(id);if(!j)throw new AppError("VIDEO_JOB_NOT_FOUND","Khong tim thay video.",404);if(j.status==="RENDERING"||j.status==="QUEUED")throw new AppError("VIDEO_JOB_BUSY","Video dang render, chua the xoa.",409);jobs.delete(id);if(j.output)await fs.unlink(j.output).catch(error=>{if(error?.code!=="ENOENT")throw error;});return{deleted:true,id};}
async function purgeExpiredVideos(){const cutoff=Date.now()-videoRetentionMs;for(const[id,j]of jobs)if(new Date(j.createdAt).getTime()<cutoff){jobs.delete(id);if(j.output)await fs.unlink(j.output).catch(()=>{});}await fs.mkdir(outputDir,{recursive:true});for(const entry of await fs.readdir(outputDir,{withFileTypes:true})){if(!entry.isFile()||!entry.name.endsWith(".mp4"))continue;const file=path.join(outputDir,entry.name),stat=await fs.stat(file).catch(()=>null);if(stat&&stat.mtimeMs<cutoff)await fs.unlink(file).catch(()=>{});}}
purgeExpiredVideos().catch(()=>{});
setInterval(()=>purgeExpiredVideos().catch(()=>{}),3600e3).unref();
