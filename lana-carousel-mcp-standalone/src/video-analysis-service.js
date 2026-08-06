import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {db} from "./db.js";
import {config} from "./config.js";
import {AppError} from "./errors.js";
import {
 evaluateVideoScriptOptions,
 getVideoTonePrompt,
 normalizeVideoAnalysisBrief,
 sanitizeVideoAnalysisEditableSettings,
 VIDEO_SCRIPT_OPTION_IDS
} from "./video-analysis-brief.js";
import {videoAnalysisJobRegistry} from "./video-analysis-job-registry.js";
import {
 isVideoSourceMutationPending,
 withVideoSourceMutationLock
} from "./video-analysis-project-locks.js";
import {
 assertManagedVideoSourceUrl,
 deleteManagedVideoSource,
 importRemoteVideoSource
} from "./video-source-importer.js";

export const videoAnalysisAssetDir=path.resolve(path.dirname(config.databasePath),"video-analysis-assets");
export const videoAnalysisOutputDir=path.resolve(path.dirname(config.databasePath),"video-analysis-renders");
await fs.mkdir(videoAnalysisAssetDir,{recursive:true});
await fs.mkdir(videoAnalysisOutputDir,{recursive:true});

db.exec(`
CREATE TABLE IF NOT EXISTS video_analysis_projects (
 id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'DRAFT',
 source_url TEXT,source_filename TEXT,source_mime TEXT,source_size INTEGER,
 duration REAL,script_json TEXT NOT NULL DEFAULT '{}',settings_json TEXT NOT NULL DEFAULT '{}',
 current_version INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS video_analysis_versions (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES video_analysis_projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(project_id,version)
);
CREATE TABLE IF NOT EXISTS video_analysis_jobs (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES video_analysis_projects(id) ON DELETE CASCADE,
 status TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,error TEXT,output_path TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_va_versions ON video_analysis_versions(project_id,version DESC);
CREATE INDEX IF NOT EXISTS idx_va_jobs ON video_analysis_jobs(project_id,created_at DESC);
`);

const ACTIVE_JOB_STATUSES=new Set(["QUEUED","RENDERING"]);
const q={
 create:db.prepare(`INSERT INTO video_analysis_projects(id,title,status,source_url,source_filename,source_mime,source_size,duration,script_json,settings_json,current_version,created_at,updated_at,expires_at) VALUES(@id,@title,@status,@source_url,@source_filename,@source_mime,@source_size,@duration,@script_json,@settings_json,0,@created_at,@updated_at,@expires_at)`),
 get:db.prepare(`SELECT * FROM video_analysis_projects WHERE id=?`),
 list:db.prepare(`SELECT * FROM video_analysis_projects ORDER BY created_at DESC`),
 updateSource:db.prepare(`UPDATE video_analysis_projects SET source_url=?,source_filename=?,source_mime=?,source_size=?,duration=?,updated_at=? WHERE id=?`),
 updateSettings:db.prepare(`UPDATE video_analysis_projects SET settings_json=?,updated_at=? WHERE id=?`),
 update:db.prepare(`UPDATE video_analysis_projects SET status=?,script_json=?,settings_json=?,current_version=?,updated_at=? WHERE id=?`),
 addVersion:db.prepare(`INSERT INTO video_analysis_versions(id,project_id,version,note,snapshot_json,created_at) VALUES(?,?,?,?,?,?)`),
 versions:db.prepare(`SELECT id,version,note,created_at FROM video_analysis_versions WHERE project_id=? ORDER BY version DESC`),
 version:db.prepare(`SELECT * FROM video_analysis_versions WHERE id=? AND project_id=?`),
 jobsByProject:db.prepare(`SELECT id,status,output_path FROM video_analysis_jobs WHERE project_id=? ORDER BY created_at ASC`),
 del:db.prepare(`DELETE FROM video_analysis_projects WHERE id=?`),
 expired:db.prepare(`SELECT * FROM video_analysis_projects WHERE datetime(expires_at)<=datetime('now')`)
};

const parse=(value,fallback)=>{try{return JSON.parse(value||"")||fallback}catch{return fallback}};
const defaults={
 ttsEnabled:false,
 ttsProvider:"vertex",
 ttsSpeed:1,
 ttsVolume:1,
 originalAudioVolume:.25,
 subtitleEnabled:true,
 subtitleFont:"TikTok Sans",
 subtitleSize:52,
 subtitleColor:"#FFFFFF",
 subtitleBackgroundColor:"#000000",
 subtitleBackgroundOpacity:.72,
 subtitleX:50,
 subtitlePosition:86,
 subtitleStyle:"karaoke",
 geminiSpeaker1Voice:"Kore",
 geminiStylePrompt:"Đọc tiếng Việt tự nhiên, rõ ràng.",
 analysisBrief:null,
 selectedScriptOption:null,
 preparedScriptOptions:null
};

function view(row){
 if(!row)throw new AppError("VIDEO_ANALYSIS_NOT_FOUND","Không tìm thấy dự án phân tích video.",404);
 const settings={...defaults,...parse(row.settings_json,{})};
 return{
  id:row.id,
  title:row.title,
  status:row.status,
  source:{url:row.source_url||"",filename:row.source_filename||"",mime:row.source_mime||"",size:row.source_size||0,duration:row.duration||0},
  script:parse(row.script_json,{summary:"",segments:[]}),
  settings,
  analysisBrief:settings.analysisBrief,
  selectedScriptOption:settings.selectedScriptOption,
  preparedScriptOptions:settings.preparedScriptOptions,
  currentVersion:row.current_version,
  createdAt:row.created_at,
  updatedAt:row.updated_at,
  expiresAt:row.expires_at,
  studioUrl:`${config.publicBaseUrl}/video-studio?projectId=${row.id}`
 };
}

function sourceLockedError(){
 return new AppError(
  "VIDEO_ANALYSIS_SOURCE_LOCKED",
  "Không thể thay video nguồn khi project đang chờ render, đang render hoặc đang có yêu cầu thay nguồn khác.",
  409
 );
}

function persistedActiveJobRows(projectId){
 return q.jobsByProject.all(projectId).filter(job=>ACTIVE_JOB_STATUSES.has(job.status));
}

function assertVideoSourceCanChange(projectId){
 q.get.get(projectId)||view(null);
 if(persistedActiveJobRows(projectId).length||videoAnalysisJobRegistry.hasActiveProject(projectId)){
  throw sourceLockedError();
 }
}

function commitVideoSourceReplacement({projectId,url,filename,mime,size,duration}){
 return db.transaction(()=>{
  const row=q.get.get(projectId);
  if(!row)return view(null);
  if(persistedActiveJobRows(projectId).length)throw sourceLockedError();
  q.updateSource.run(url,filename,mime,size,duration,new Date().toISOString(),projectId);
  return row.source_url||"";
 })();
}

function normalizedStoredOption(option){
 return{
  optionId:option.optionId,
  label:option.label,
  segments:option.segments.map(segment=>({
   id:segment.id,
   start:segment.start,
   end:segment.end,
   subtitleText:segment.subtitleText,
   voiceOverText:segment.voiceOverText,
   speaker:segment.speaker||"speaker1",
   enabled:segment.enabled!==false
  }))
 };
}

function preparedHashPayload(prepared){
 return{
  projectId:prepared.projectId,
  baseVersion:prepared.baseVersion,
  summary:prepared.summary,
  analysisBrief:prepared.analysisBrief,
  sourceUrl:prepared.sourceUrl,
  sourceDuration:prepared.sourceDuration,
  options:prepared.options
 };
}

function hashPreparedOptions(prepared){
 return createHash("sha256").update(JSON.stringify(preparedHashPayload(prepared))).digest("hex");
}

function sameJson(left,right){return JSON.stringify(left)===JSON.stringify(right)}

function resolveManagedSettings(currentSettings,editableSettings,managedSettings={}){
 const hasManagedBrief=Object.prototype.hasOwnProperty.call(managedSettings,"analysisBrief");
 const hasManagedSelection=Object.prototype.hasOwnProperty.call(managedSettings,"selectedScriptOption");
 const hasManagedPrepared=Object.prototype.hasOwnProperty.call(managedSettings,"preparedScriptOptions");
 const analysisBrief=hasManagedBrief
  ?normalizeVideoAnalysisBrief(managedSettings.analysisBrief,{required:false})
  :currentSettings.analysisBrief;
 const selectedScriptOption=hasManagedSelection
  ?managedSettings.selectedScriptOption
  :currentSettings.selectedScriptOption;
 if(selectedScriptOption&&!VIDEO_SCRIPT_OPTION_IDS.includes(selectedScriptOption)){
  throw new AppError("INVALID_VIDEO_SCRIPT_OPTION","Phương án script được chọn không hợp lệ.",422);
 }
 const preparedScriptOptions=hasManagedPrepared?managedSettings.preparedScriptOptions:null;
 const nextSettings={
  ...currentSettings,
  ...sanitizeVideoAnalysisEditableSettings(editableSettings),
  analysisBrief,
  selectedScriptOption,
  preparedScriptOptions
 };
 if(analysisBrief){
  nextSettings.ttsSpeed=analysisBrief.ttsSpeed;
  nextSettings.geminiStylePrompt=getVideoTonePrompt(analysisBrief.toneStyle);
 }
 return nextSettings;
}

export function createVideoAnalysisProject({title,sourceUrl="",sourceFilename="",sourceMime="",sourceSize=0,duration=0,analysisBrief=null}){
 if(sourceUrl)assertManagedVideoSourceUrl(sourceUrl);
 const createdAt=new Date(),id=randomUUID(),iso=createdAt.toISOString();
 const normalizedBrief=normalizeVideoAnalysisBrief(analysisBrief,{required:false});
 const initialSettings={
  ...defaults,
  analysisBrief:normalizedBrief,
  ttsSpeed:normalizedBrief?.ttsSpeed??defaults.ttsSpeed,
  geminiStylePrompt:normalizedBrief?getVideoTonePrompt(normalizedBrief.toneStyle):defaults.geminiStylePrompt
 };
 q.create.run({
  id,
  title,
  status:"DRAFT",
  source_url:sourceUrl,
  source_filename:sourceFilename,
  source_mime:sourceMime,
  source_size:sourceSize,
  duration,
  script_json:JSON.stringify({summary:"",segments:[]}),
  settings_json:JSON.stringify(initialSettings),
  created_at:iso,
  updated_at:iso,
  expires_at:new Date(createdAt.getTime()+14*864e5).toISOString()
 });
 return getVideoAnalysisProject(id);
}

export async function createVideoAnalysisProjectFromRemoteSource({sourceUrl,sourceFilename="video.mp4",...input}){
 if(!sourceUrl)return createVideoAnalysisProject(input);
 const imported=await importRemoteVideoSource({url:sourceUrl,filename:sourceFilename});
 try{
  return createVideoAnalysisProject({
   ...input,
   sourceUrl:imported.url,
   sourceFilename:imported.filename,
   sourceMime:imported.mime,
   sourceSize:imported.size
  });
 }catch(error){
  await deleteManagedVideoSource(imported.url);
  throw error;
 }
}

export function getVideoAnalysisProject(id){return view(q.get.get(id));}
export function listVideoAnalysisProjects(){return q.list.all().map(view);}

export function attachVideoSource({projectId,url,filename,mime="video/mp4",size=0,duration=0}){
 if(isVideoSourceMutationPending(projectId))throw sourceLockedError();
 assertManagedVideoSourceUrl(url);
 assertVideoSourceCanChange(projectId);
 commitVideoSourceReplacement({projectId,url,filename,mime,size,duration});
 return getVideoAnalysisProject(projectId);
}

export async function replaceManagedVideoSource({projectId,url,filename,mime="video/mp4",size=0,duration=0}){
 assertManagedVideoSourceUrl(url);
 return withVideoSourceMutationLock(projectId,async()=>{
  assertVideoSourceCanChange(projectId);
  const previousSourceUrl=commitVideoSourceReplacement({projectId,url,filename,mime,size,duration});
  if(previousSourceUrl&&previousSourceUrl!==url)await deleteManagedVideoSource(previousSourceUrl);
  return getVideoAnalysisProject(projectId);
 });
}

export async function attachRemoteVideoSource({
 projectId,
 url,
 filename="video.mp4",
 duration=0,
 importer=importRemoteVideoSource
}){
 return withVideoSourceMutationLock(projectId,async()=>{
  assertVideoSourceCanChange(projectId);
  let imported;
  try{
   imported=await importer({url,filename});
   assertManagedVideoSourceUrl(imported.url);
   assertVideoSourceCanChange(projectId);
   const previousSourceUrl=commitVideoSourceReplacement({
    projectId,
    url:imported.url,
    filename:imported.filename,
    mime:imported.mime,
    size:imported.size,
    duration
   });
   if(previousSourceUrl&&previousSourceUrl!==imported.url){
    await deleteManagedVideoSource(previousSourceUrl);
   }
   return getVideoAnalysisProject(projectId);
  }catch(error){
   if(imported?.url)await deleteManagedVideoSource(imported.url);
   throw error;
  }
 });
}

export function prepareVideoAnalysisScriptOptions({projectId,summary="",options}){
 const row=q.get.get(projectId);
 if(!row)return view(null);
 const currentSettings={...defaults,...parse(row.settings_json,{})};
 if(!currentSettings.analysisBrief){
  throw new AppError("VIDEO_ANALYSIS_BRIEF_REQUIRED","Project chưa có content brief.",422);
 }
 const evaluated=evaluateVideoScriptOptions({brief:currentSettings.analysisBrief,options});
 const prepared={
  id:randomUUID(),
  projectId,
  baseVersion:Number(row.current_version||0),
  createdAt:new Date().toISOString(),
  summary:String(summary||""),
  analysisBrief:evaluated.analysisBrief,
  sourceUrl:row.source_url||"",
  sourceDuration:Number(row.duration||0),
  options:evaluated.options.map(normalizedStoredOption)
 };
 prepared.contentHash=hashPreparedOptions(prepared);
 const nextSettings={...currentSettings,preparedScriptOptions:prepared};
 q.updateSettings.run(JSON.stringify(nextSettings),new Date().toISOString(),projectId);
 return{
  projectId,
  preparedOptionsId:prepared.id,
  contentHash:prepared.contentHash,
  summary:prepared.summary,
  ...evaluated
 };
}

export function saveVideoAnalysisScript({projectId,script,settings={},managedSettings={},approved=false,note=""}){
 const row=q.get.get(projectId);
 if(!row)return view(null);
 const segments=(script?.segments||[]).map((segment,index)=>({
  id:segment.id||randomUUID(),
  start:Number(segment.start||0),
  end:Number(segment.end||0),
  subtitleText:String(segment.subtitleText||""),
  voiceOverText:String(segment.voiceOverText||segment.subtitleText||""),
  speaker:segment.speaker||"speaker1",
  enabled:segment.enabled!==false,
  order:index
 }));
 for(const segment of segments){
  if(!(segment.end>segment.start))throw new AppError("INVALID_SEGMENT_TIME","Thời gian kết thúc phải lớn hơn thời gian bắt đầu.",422);
 }

 const normalized={summary:String(script?.summary||""),language:script?.language||"vi-VN",segments};
 const currentSettings={...defaults,...parse(row.settings_json,{})};
 const nextSettings=resolveManagedSettings(currentSettings,settings,managedSettings);
 const version=Number(row.current_version||0)+1;
 const snapshot={status:approved?"APPROVED":"DRAFT",script:normalized,settings:nextSettings};
 const transaction=db.transaction(()=>{
  q.addVersion.run(randomUUID(),projectId,version,note||(approved?"Duyệt script":"Lưu bản nháp"),JSON.stringify(snapshot),new Date().toISOString());
  q.update.run(snapshot.status,JSON.stringify(snapshot.script),JSON.stringify(snapshot.settings),version,new Date().toISOString(),projectId);
 });
 transaction();
 return getVideoAnalysisProject(projectId);
}

export function savePreparedVideoAnalysisScript({projectId,preparedOptionsId,selectedOption,settings={},approved=true,note=""}){
 const row=q.get.get(projectId);
 if(!row)return view(null);
 const currentSettings={...defaults,...parse(row.settings_json,{})};
 const prepared=currentSettings.preparedScriptOptions;
 if(!prepared||prepared.id!==preparedOptionsId){
  throw new AppError("VIDEO_SCRIPT_OPTIONS_NOT_PREPARED","Không tìm thấy bộ phương án đã chuẩn bị hoặc bộ phương án đã bị thay thế.",409);
 }
 if(Number(row.current_version||0)!==Number(prepared.baseVersion||0)){
  throw new AppError("VIDEO_SCRIPT_OPTIONS_STALE","Project đã thay đổi sau khi chuẩn bị phương án. Hãy chuẩn bị lại hai phương án.",409);
 }
 if(!sameJson(currentSettings.analysisBrief,prepared.analysisBrief)){
  throw new AppError("VIDEO_SCRIPT_OPTIONS_STALE","Content brief đã thay đổi. Hãy chuẩn bị lại hai phương án.",409);
 }
 if((row.source_url||"")!==(prepared.sourceUrl||"")||Number(row.duration||0)!==Number(prepared.sourceDuration||0)){
  throw new AppError("VIDEO_SCRIPT_OPTIONS_STALE","Video nguồn đã thay đổi. Hãy chuẩn bị lại hai phương án.",409);
 }
 if(hashPreparedOptions(prepared)!==prepared.contentHash){
  throw new AppError("VIDEO_SCRIPT_OPTIONS_INTEGRITY_ERROR","Dữ liệu phương án đã chuẩn bị không còn toàn vẹn.",409);
 }
 if(!VIDEO_SCRIPT_OPTION_IDS.includes(selectedOption)){
  throw new AppError("INVALID_VIDEO_SCRIPT_OPTION","Phương án script được chọn không hợp lệ.",422);
 }
 const option=prepared.options.find(item=>item.optionId===selectedOption);
 if(!option){
  throw new AppError("VIDEO_SCRIPT_OPTION_NOT_FOUND","Không tìm thấy nội dung của phương án được chọn.",409);
 }
 return saveVideoAnalysisScript({
  projectId,
  approved,
  note,
  script:{summary:prepared.summary,language:"vi-VN",segments:option.segments},
  settings,
  managedSettings:{
   analysisBrief:currentSettings.analysisBrief,
   selectedScriptOption:selectedOption,
   preparedScriptOptions:null
  }
 });
}

export function getVideoAnalysisVersions(id){getVideoAnalysisProject(id);return q.versions.all(id);}

export function restoreVideoAnalysisVersion(projectId,versionId){
 const version=q.version.get(versionId,projectId);
 if(!version)throw new AppError("VIDEO_ANALYSIS_VERSION_NOT_FOUND","Không tìm thấy phiên bản.",404);
 const snapshot=parse(version.snapshot_json,{});
 return saveVideoAnalysisScript({
  projectId,
  script:snapshot.script,
  settings:snapshot.settings,
  managedSettings:{
   analysisBrief:snapshot.settings?.analysisBrief??null,
   selectedScriptOption:snapshot.settings?.selectedScriptOption??null,
   preparedScriptOptions:null
  },
  approved:snapshot.status==="APPROVED",
  note:`Khôi phục v${version.version}`
 });
}

function managedRenderPath(value){
 if(!value)return null;
 const resolved=path.resolve(String(value));
 const root=`${path.resolve(videoAnalysisOutputDir)}${path.sep}`;
 return resolved.startsWith(root)?resolved:null;
}

export async function deleteVideoAnalysisProject(id){
 const row=q.get.get(id);
 if(!row)return view(null);
 if(isVideoSourceMutationPending(id))throw sourceLockedError();
 const jobRows=q.jobsByProject.all(id);
 const activeJobs=jobRows.filter(job=>ACTIVE_JOB_STATUSES.has(job.status));
 if(activeJobs.length||videoAnalysisJobRegistry.hasActiveProject(id)){
  throw new AppError(
   "VIDEO_ANALYSIS_JOBS_ACTIVE",
   "Không thể xóa dự án khi video đang chờ hoặc đang render. Hãy đợi job hoàn tất rồi thử lại.",
   409
  );
 }
 const outputPaths=jobRows.map(job=>managedRenderPath(job.output_path)).filter(Boolean);
 db.transaction(()=>q.del.run(id))();
 videoAnalysisJobRegistry.forgetProject(id);
 await Promise.all(outputPaths.map(file=>fs.unlink(file).catch(()=>{})));
 await deleteManagedVideoSource(row.source_url);
 return{deleted:true,id,deletedJobs:jobRows.length,deletedOutputs:outputPaths.length};
}

export async function purgeExpiredVideoAnalysis(){
 for(const row of q.expired.all()){
  await deleteVideoAnalysisProject(row.id).catch(error=>{
   if(!["VIDEO_ANALYSIS_JOBS_ACTIVE","VIDEO_ANALYSIS_SOURCE_LOCKED"].includes(error?.code))throw error;
  });
 }
}
