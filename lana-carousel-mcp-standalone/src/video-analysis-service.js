import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {db} from "./db.js";
import {config} from "./config.js";
import {AppError} from "./errors.js";

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
 get:db.prepare(`SELECT * FROM video_analysis_projects WHERE id=?`),list:db.prepare(`SELECT * FROM video_analysis_projects ORDER BY created_at DESC`),
 updateSource:db.prepare(`UPDATE video_analysis_projects SET source_url=?,source_filename=?,source_mime=?,source_size=?,duration=?,updated_at=? WHERE id=?`),
 update:db.prepare(`UPDATE video_analysis_projects SET status=?,script_json=?,settings_json=?,current_version=?,updated_at=? WHERE id=?`),
 addVersion:db.prepare(`INSERT INTO video_analysis_versions(id,project_id,version,note,snapshot_json,created_at) VALUES(?,?,?,?,?,?)`),
 versions:db.prepare(`SELECT id,version,note,created_at FROM video_analysis_versions WHERE project_id=? ORDER BY version DESC`),version:db.prepare(`SELECT * FROM video_analysis_versions WHERE id=? AND project_id=?`),
 del:db.prepare(`DELETE FROM video_analysis_projects WHERE id=?`),expired:db.prepare(`SELECT * FROM video_analysis_projects WHERE datetime(expires_at)<=datetime('now')`)
};
const parse=(v,f)=>{try{return JSON.parse(v||"")||f}catch{return f}};
const defaults={ttsEnabled:false,ttsProvider:"vertex",ttsSpeed:1,ttsVolume:1,originalAudioVolume:.25,subtitleEnabled:true,subtitleFont:"TikTok Sans",subtitleSize:52,subtitleColor:"#FFFFFF",subtitleBackgroundColor:"#000000",subtitleBackgroundOpacity:.72,subtitlePosition:86,subtitleStyle:"karaoke",geminiSpeaker1Voice:"Kore",geminiStylePrompt:"Đọc tiếng Việt tự nhiên, rõ ràng."};
function view(r){if(!r)throw new AppError("VIDEO_ANALYSIS_NOT_FOUND","Không tìm thấy dự án phân tích video.",404);return{id:r.id,title:r.title,status:r.status,source:{url:r.source_url||"",filename:r.source_filename||"",mime:r.source_mime||"",size:r.source_size||0,duration:r.duration||0},script:parse(r.script_json,{summary:"",segments:[]}),settings:{...defaults,...parse(r.settings_json,{})},currentVersion:r.current_version,createdAt:r.created_at,updatedAt:r.updated_at,expiresAt:r.expires_at,studioUrl:`${config.publicBaseUrl}/video-studio?projectId=${r.id}`};}
export function createVideoAnalysisProject({title,sourceUrl="",sourceFilename=""}){const t=new Date(),id=randomUUID(),iso=t.toISOString();q.create.run({id,title,status:"DRAFT",source_url:sourceUrl,source_filename:sourceFilename,source_mime:"",source_size:0,duration:0,script_json:JSON.stringify({summary:"",segments:[]}),settings_json:JSON.stringify(defaults),created_at:iso,updated_at:iso,expires_at:new Date(t.getTime()+14*864e5).toISOString()});return getVideoAnalysisProject(id);}
export function getVideoAnalysisProject(id){return view(q.get.get(id));}
export function listVideoAnalysisProjects(){return q.list.all().map(view);}
export function attachVideoSource({projectId,url,filename,mime="video/mp4",size=0,duration=0}){q.get.get(projectId)||view(null);q.updateSource.run(url,filename,mime,size,duration,new Date().toISOString(),projectId);return getVideoAnalysisProject(projectId);}
export function saveVideoAnalysisScript({projectId,script,settings={},approved=false,note=""}){const row=q.get.get(projectId);if(!row)return view(null);const segments=(script?.segments||[]).map((s,i)=>({id:s.id||randomUUID(),start:Number(s.start||0),end:Number(s.end||0),subtitleText:String(s.subtitleText||""),voiceOverText:String(s.voiceOverText||s.subtitleText||""),speaker:s.speaker||"speaker1",enabled:s.enabled!==false,order:i}));for(const s of segments)if(!(s.end>s.start))throw new AppError("INVALID_SEGMENT_TIME","Thời gian kết thúc phải lớn hơn thời gian bắt đầu.",422);const normalized={summary:String(script?.summary||""),language:script?.language||"vi-VN",segments};const version=Number(row.current_version||0)+1,snapshot={status:approved?"APPROVED":"DRAFT",script:normalized,settings:{...defaults,...parse(row.settings_json,{}),...settings}};const tx=db.transaction(()=>{q.addVersion.run(randomUUID(),projectId,version,note|| (approved?"Duyệt script":"Lưu bản nháp"),JSON.stringify(snapshot),new Date().toISOString());q.update.run(snapshot.status,JSON.stringify(snapshot.script),JSON.stringify(snapshot.settings),version,new Date().toISOString(),projectId)});tx();return getVideoAnalysisProject(projectId);}
export function getVideoAnalysisVersions(id){getVideoAnalysisProject(id);return q.versions.all(id);}
export function restoreVideoAnalysisVersion(projectId,versionId){const v=q.version.get(versionId,projectId);if(!v)throw new AppError("VIDEO_ANALYSIS_VERSION_NOT_FOUND","Không tìm thấy phiên bản.",404);const snap=parse(v.snapshot_json,{}),next=saveVideoAnalysisScript({projectId,script:snap.script,settings:snap.settings,approved:snap.status==="APPROVED",note:`Khôi phục v${v.version}`});return next;}
export async function deleteVideoAnalysisProject(id){const row=q.get.get(id);if(!row)return view(null);q.del.run(id);if(row.source_url?.startsWith(`${config.publicBaseUrl}/video-analysis-assets/`))await fs.unlink(path.join(videoAnalysisAssetDir,path.basename(row.source_url))).catch(()=>{});return{deleted:true,id};}
export async function purgeExpiredVideoAnalysis(){for(const row of q.expired.all())await deleteVideoAnalysisProject(row.id).catch(()=>{});}
