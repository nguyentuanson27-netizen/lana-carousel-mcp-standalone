import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {db} from "./db.js";
import {config} from "./config.js";
import {AppError} from "./errors.js";
import {
  getVideoTonePrompt,
  normalizeVideoAnalysisBrief,
  VIDEO_SCRIPT_OPTION_IDS
} from "./video-analysis-brief.js";

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

const q={
 create:db.prepare(`INSERT INTO video_analysis_projects(id,title,status,source_url,source_filename,source_mime,source_size,duration,script_json,settings_json,current_version,created_at,updated_at,expires_at) VALUES(@id,@title,@status,@source_url,@source_filename,@source_mime,@source_size,@duration,@script_json,@settings_json,0,@created_at,@updated_at,@expires_at)`),
 get:db.prepare(`SELECT * FROM video_analysis_projects WHERE id=?`),
 list:db.prepare(`SELECT * FROM video_analysis_projects ORDER BY created_at DESC`),
 updateSource:db.prepare(`UPDATE video_analysis_projects SET source_url=?,source_filename=?,source_mime=?,source_size=?,duration=?,updated_at=? WHERE id=?`),
 update:db.prepare(`UPDATE video_analysis_projects SET status=?,script_json=?,settings_json=?,current_version=?,updated_at=? WHERE id=?`),
 addVersion:db.prepare(`INSERT INTO video_analysis_versions(id,project_id,version,note,snapshot_json,created_at) VALUES(?,?,?,?,?,?)`),
 versions:db.prepare(`SELECT id,version,note,created_at FROM video_analysis_versions WHERE project_id=? ORDER BY version DESC`),
 version:db.prepare(`SELECT * FROM video_analysis_versions WHERE id=? AND project_id=?`),
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
 selectedScriptOption:null
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
  currentVersion:row.current_version,
  createdAt:row.created_at,
  updatedAt:row.updated_at,
  expiresAt:row.expires_at,
  studioUrl:`${config.publicBaseUrl}/video-studio?projectId=${row.id}`
 };
}

export function createVideoAnalysisProject({title,sourceUrl="",sourceFilename="",analysisBrief=null}){
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
  source_mime:"",
  source_size:0,
  duration:0,
  script_json:JSON.stringify({summary:"",segments:[]}),
  settings_json:JSON.stringify(initialSettings),
  created_at:iso,
  updated_at:iso,
  expires_at:new Date(createdAt.getTime()+14*864e5).toISOString()
 });
 return getVideoAnalysisProject(id);
}

export function getVideoAnalysisProject(id){return view(q.get.get(id));}
export function listVideoAnalysisProjects(){return q.list.all().map(view);}

export function attachVideoSource({projectId,url,filename,mime="video/mp4",size=0,duration=0}){
 q.get.get(projectId)||view(null);
 q.updateSource.run(url,filename,mime,size,duration,new Date().toISOString(),projectId);
 return getVideoAnalysisProject(projectId);
}

export function saveVideoAnalysisScript({projectId,script,settings={},approved=false,note=""}){
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
 const nextAnalysisBrief=settings.analysisBrief===undefined
  ? currentSettings.analysisBrief
  : normalizeVideoAnalysisBrief(settings.analysisBrief,{required:false});
 const selectedScriptOption=settings.selectedScriptOption??currentSettings.selectedScriptOption;
 if(selectedScriptOption&&!VIDEO_SCRIPT_OPTION_IDS.includes(selectedScriptOption)){
  throw new AppError("INVALID_VIDEO_SCRIPT_OPTION","Phương án script được chọn không hợp lệ.",422);
 }
 const nextSettings={...currentSettings,...settings,analysisBrief:nextAnalysisBrief,selectedScriptOption};
 const version=Number(row.current_version||0)+1;
 const snapshot={status:approved?"APPROVED":"DRAFT",script:normalized,settings:nextSettings};
 const transaction=db.transaction(()=>{
  q.addVersion.run(randomUUID(),projectId,version,note||(approved?"Duyệt script":"Lưu bản nháp"),JSON.stringify(snapshot),new Date().toISOString());
  q.update.run(snapshot.status,JSON.stringify(snapshot.script),JSON.stringify(snapshot.settings),version,new Date().toISOString(),projectId);
 });
 transaction();
 return getVideoAnalysisProject(projectId);
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
  approved:snapshot.status==="APPROVED",
  note:`Khôi phục v${version.version}`
 });
}

export async function deleteVideoAnalysisProject(id){
 const row=q.get.get(id);
 if(!row)return view(null);
 q.del.run(id);
 if(row.source_url?.startsWith(`${config.publicBaseUrl}/video-analysis-assets/`)){
  await fs.unlink(path.join(videoAnalysisAssetDir,path.basename(row.source_url))).catch(()=>{});
 }
 return{deleted:true,id};
}

export async function purgeExpiredVideoAnalysis(){
 for(const row of q.expired.all())await deleteVideoAnalysisProject(row.id).catch(()=>{});
}
