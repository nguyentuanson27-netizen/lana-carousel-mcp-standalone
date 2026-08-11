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

// getVideoMetadata của Remotion treo trên file thuần audio, nên tự đọc header.
// Vertex luôn trả WAV, nhánh Google trả MP3 — cả hai đều phải đo được độ dài thật.
export function wavDurationSeconds(buffer){
 if(buffer.length<44)return 0;
 if(buffer.toString("ascii",0,4)!=="RIFF"||buffer.toString("ascii",8,12)!=="WAVE")return 0;
 let offset=12;
 let byteRate=0;
 while(offset+8<=buffer.length){
  const chunkId=buffer.toString("ascii",offset,offset+4);
  const chunkSize=buffer.readUInt32LE(offset+4);
  if(chunkId==="fmt "&&offset+20<=buffer.length)byteRate=buffer.readUInt32LE(offset+16);
  if(chunkId==="data")return byteRate>0?Math.min(chunkSize,buffer.length-offset-8)/byteRate:0;
  offset+=8+chunkSize+(chunkSize%2);
 }
 return 0;
}

const MP3_LAYER_III=1;
const MP3_VERSION_1=3;
const MP3_TRAILING_SLACK=512;
const MP3_BITRATES={
 1:[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0],
 2:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0]
};
const MP3_SAMPLE_RATES={3:[44100,48000,32000],2:[22050,24000,16000],0:[11025,12000,8000]};

// Nhánh TTS Google trả MP3 kèm độ dài chỉ ước lượng theo số từ. Cộng dồn độ dài từng frame
// cho ra độ dài thật, đúng cho cả CBR lẫn VBR, và không có rủi ro treo như getVideoMetadata.
export function mp3DurationSeconds(buffer){
 let offset=0;
 if(buffer.length>10&&buffer.toString("ascii",0,3)==="ID3"){
  const tagSize=(buffer[6]<<21)|(buffer[7]<<14)|(buffer[8]<<7)|buffer[9];
  offset=10+tagSize+((buffer[5]&0x10)?10:0);
 }
 let duration=0;
 let frames=0;
 while(offset+4<=buffer.length){
  if(buffer[offset]!==0xff||(buffer[offset+1]&0xe0)!==0xe0)break;
  const version=(buffer[offset+1]>>3)&0x03;
  const layer=(buffer[offset+1]>>1)&0x03;
  if(version===1||layer!==MP3_LAYER_III)break;
  const bitrate=MP3_BITRATES[version===MP3_VERSION_1?1:2][(buffer[offset+2]>>4)&0x0f]*1000;
  const sampleRate=MP3_SAMPLE_RATES[version][(buffer[offset+2]>>2)&0x03];
  if(!bitrate||!sampleRate)break;
  const frameLength=Math.floor((version===MP3_VERSION_1?144:72)*bitrate/sampleRate)+((buffer[offset+2]>>1)&0x01);
  if(frameLength<4)break;
  duration+=(version===MP3_VERSION_1?1152:576)/sampleRate;
  frames+=1;
  offset+=frameLength;
 }
 // Chỉ tin kết quả khi đã duyệt gần hết file. Dừng giữa chừng nghĩa là gặp dữ liệu không
 // đọc được, và con số thu được sẽ ngắn hơn thật — đúng hướng gây cắt mất tiếng.
 return frames>0&&buffer.length-offset<=MP3_TRAILING_SLACK?duration:0;
}

function measureAudioDuration(buffer,extension){
 if(extension==="wav")return wavDurationSeconds(buffer);
 if(extension==="mp3")return mp3DurationSeconds(buffer);
 return 0;
}

async function materializeTtsTrack(jobId,index,dataUrl){
 const {buffer,extension}=decodeAudioDataUrl(dataUrl);
 const filename=`tts-${jobId}-${index}.${extension}`;
 const filePath=path.join(videoAnalysisAssetDir,filename);
 await fs.writeFile(filePath,buffer,{flag:"wx"});
 return{
  filePath,
  measuredDuration:measureAudioDuration(buffer,extension),
  url:`${config.publicBaseUrl.replace(/\/$/u,"")}/video-analysis-assets/${encodeURIComponent(filename)}`
 };
}

// Không được ném lỗi khi worker đầu tiên hỏng: các worker còn lại vẫn đang chạy và vẫn sẽ
// ghi file tạm. Nếu work() dọn dẹp ngay lúc đó thì file ghi muộn bị bỏ sót lại trong
// thư mục asset và không có ai xoá. Dừng nhận việc mới, chờ tất cả dừng hẳn rồi mới báo lỗi.
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

async function synthesizeSegmentVoice({jobId,settings,segment,index,temporaryVoicePaths}){
 const single={slides:[{
  headline:segment.subtitleText,
  body:segment.voiceOverText,
  video:{enabled:true,caption:segment.voiceOverText,speaker:segment.speaker}
 }]};
 const track=await generateVideoTtsTrack(single,segmentVoiceSettings(settings,segment));
 if(!track?.dataUrl)return null;
 const asset=await materializeTtsTrack(jobId,index,track.dataUrl);
 temporaryVoicePaths.push(asset.filePath);
 // Nhánh Google trả MP3 kèm độ dài chỉ ước lượng theo số từ, không phải độ dài thật.
 // Phải phân biệt để bên dưới không cắt clip theo một con số đoán.
 const measured=asset.measuredDuration>0;
 const rawDuration=measured?asset.measuredDuration:Number(track.durationSeconds||0);
 return rawDuration>0?{url:asset.url,rawDuration,measured}:null;
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

async function buildVoiceTracks({jobId,settings,segments,mediaScope,temporaryVoicePaths}){
 const clips=await mapWithLimit(segments,TTS_CONCURRENCY,(segment,index)=>
  synthesizeSegmentVoice({jobId,settings,segment,index,temporaryVoicePaths}));
 return planVoiceTracks({segments,clips,ttsSpeed:settings.ttsSpeed})
  .map(track=>({...track,url:createSignedMediaUrl(track.url,mediaScope)}));
}

async function work(job){
 const temporaryVoicePaths=[];
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
    jobId:job.id,
    settings:project.settings,
    segments:project.script.segments.filter(segment=>segment.enabled!==false),
    mediaScope,
    temporaryVoicePaths
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
 }finally{
  for(const file of temporaryVoicePaths)await fs.unlink(file).catch(()=>{});
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
