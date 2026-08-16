import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {config} from "./config.js";
import {AppError,publicError} from "./errors.js";
import {
 VIDEO_CONTENT_DOMAINS,
 VIDEO_CONTENT_GOALS,
 VIDEO_SCRIPT_OPTION_IDS,
 VIDEO_TONE_STYLES,
 VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";
import {
 attachRemoteVideoSource,
 createVideoAnalysisProject,
 createVideoAnalysisProjectFromRemoteSource,
 deleteVideoAnalysisProject,
 getVideoAnalysisProject,
 getVideoAnalysisVersions,
 listVideoAnalysisProjects,
 prepareVideoAnalysisScriptOptions,
 replaceManagedVideoSource,
 restoreVideoAnalysisVersion,
 savePreparedVideoAnalysisScript,
 saveVideoAnalysisScript,
 videoAnalysisAssetDir
} from "./video-analysis-service.js";
import {buildVoiceTracks,getVideoAnalysisFile,getVideoAnalysisJob,startVideoAnalysisJob} from "./video-analysis-jobs.js";
import {synthesizeCachedSpeech} from "./video-tts-cache.js";
import {allowedSampleVoices,sampledVoiceName,voiceSampleSettings} from "./video-tts.js";
import {buildSubtitleFile} from "./video-subtitles.js";
import {createSignedMediaUrl} from "./media-access.js";
import {probeVideoDurationSeconds} from "./video-source-importer.js";

export const videoAnalysisRouter=express.Router();
const safe=handler=>async(req,res)=>{try{await handler(req,res)}catch(error){const response=publicError(error);res.status(response.status).json(response)}};
const ttsSpeedSchema=z.union(VIDEO_TTS_SPEEDS.map(value=>z.literal(value)));
const colorSchema=z.string().regex(/^#[0-9A-F]{6}$/iu);
const analysisBriefSchema=z.object({
 contentDomain:z.enum(VIDEO_CONTENT_DOMAINS),
 contentGoal:z.enum(VIDEO_CONTENT_GOALS).nullable().optional(),
 toneStyle:z.enum(VIDEO_TONE_STYLES),
 ttsSpeed:ttsSpeedSchema,
 customContentDomain:z.string().max(200).nullable().optional(),
 customContentGoal:z.string().max(200).nullable().optional()
}).strict();
const segmentSchema=z.object({
 id:z.string().optional(),
 start:z.number().min(0),
 end:z.number().positive(),
 subtitleText:z.string().max(2000),
 voiceOverText:z.string().max(4000),
 speaker:z.enum(["speaker1","speaker2"]).default("speaker1"),
 enabled:z.boolean().default(true),
 // saveVideoAnalysisScript tự đánh số `order` theo vị trí trong mảng rồi lưu kèm, nên GET trả
 // về trường này và studio gửi nguyên mảng đó lên lại. Schema `.strict()` không nhận thì mọi
 // lượt lưu, duyệt, render và nghe thử trên video đều chết. Giá trị gửi lên chỉ để round-trip
 // được: thứ tự vẫn luôn được tính lại từ vị trí trong mảng.
 order:z.number().int().min(0).optional()
}).strict();
const preparedSegmentSchema=segmentSchema.extend({
 id:z.string().min(1).max(100),
 subtitleText:z.string().min(1).max(2000),
 voiceOverText:z.string().min(1).max(4000)
});
const editableVideoSettingsSchema=z.object({
 ttsEnabled:z.boolean().optional(),
 ttsProvider:z.enum(["vertex","gemini","google"]).optional(),
 ttsSpeed:ttsSpeedSchema.optional(),
 ttsVolume:z.number().min(0).max(1).optional(),
 ttsVoice:z.string().min(1).max(100).optional(),
 originalAudioVolume:z.number().min(0).max(1).optional(),
 subtitleEnabled:z.boolean().optional(),
 subtitleFont:z.string().min(1).max(100).optional(),
 subtitleSize:z.number().min(20).max(96).optional(),
 subtitleColor:colorSchema.optional(),
 subtitleBackgroundColor:colorSchema.optional(),
 subtitleBackgroundOpacity:z.number().min(0).max(1).optional(),
 subtitleX:z.number().min(6).max(94).optional(),
 subtitlePosition:z.number().min(6).max(94).optional(),
 subtitleStyle:z.enum(["karaoke","word","static"]).optional(),
 geminiSpeaker1Voice:z.string().min(1).max(100).optional(),
 geminiSpeaker2Voice:z.string().min(1).max(100).optional(),
 geminiSpeaker1Name:z.string().min(1).max(100).optional(),
 geminiSpeaker2Name:z.string().min(1).max(100).optional(),
 geminiMultiSpeaker:z.boolean().optional(),
 geminiModel:z.string().min(1).max(150).optional()
}).strict();

videoAnalysisRouter.post("/projects",safe(async(req,res)=>{
 const body=z.object({
  title:z.string().min(1).max(200),
  sourceUrl:z.string().url().optional(),
  sourceFilename:z.string().max(255).optional(),
  analysisBrief:analysisBriefSchema.nullable().optional()
 }).strict().parse(req.body);
 const project=body.sourceUrl
  ?await createVideoAnalysisProjectFromRemoteSource(body)
  :createVideoAnalysisProject(body);
 res.status(201).json(project);
}));

videoAnalysisRouter.get("/projects",safe((_req,res)=>res.json({projects:listVideoAnalysisProjects()})));
videoAnalysisRouter.get("/projects/:id",safe((req,res)=>res.json(getVideoAnalysisProject(req.params.id))));
videoAnalysisRouter.delete("/projects/:id",safe(async(req,res)=>res.json(await deleteVideoAnalysisProject(req.params.id))));

videoAnalysisRouter.put("/projects/:id/source-reference",safe(async(req,res)=>{
 const body=z.object({
  url:z.string().url(),
  filename:z.string().max(255).default("video.mp4"),
  mime:z.string().max(100).optional(),
  duration:z.number().min(0).default(0)
 }).strict().parse(req.body);
 res.json(await attachRemoteVideoSource({projectId:req.params.id,...body}));
}));

videoAnalysisRouter.post(
 "/projects/:id/source-upload",
 express.raw({type:["video/mp4","video/webm","video/quicktime","application/octet-stream"],limit:"500mb"}),
 safe(async(req,res)=>{
  getVideoAnalysisProject(req.params.id);
  if(!Buffer.isBuffer(req.body)||req.body.length<1024)throw new Error("File video trống hoặc không hợp lệ.");
  const mime=String(req.headers["content-type"]||"video/mp4").split(";")[0];
  const extension=mime.includes("webm")?"webm":mime.includes("quicktime")?"mov":"mp4";
  const name=`${req.params.id}-${randomUUID()}.${extension}`;
  const absolutePath=path.join(videoAnalysisAssetDir,name);
  const url=`${config.publicBaseUrl}/video-analysis-assets/${encodeURIComponent(name)}`;
  await fs.writeFile(absolutePath,req.body,{flag:"wx"});
  try{
   const project=await replaceManagedVideoSource({
    projectId:req.params.id,
    url,
    filename:String(req.query.filename||name),
    mime,
    size:req.body.length,
    duration:await probeVideoDurationSeconds(absolutePath)
   });
   res.status(201).json(project);
  }catch(error){
   await fs.unlink(absolutePath).catch(()=>{});
   throw error;
  }
 })
);

const prepareOptionsHandler=safe((req,res)=>{
 const body=z.object({
  summary:z.string().max(5000).default(""),
  options:z.array(z.object({
   optionId:z.enum(VIDEO_SCRIPT_OPTION_IDS),
   label:z.string().min(1).max(200),
   segments:z.array(preparedSegmentSchema).min(1).max(500)
  }).strict()).length(2)
 }).strict().parse(req.body);
 res.json(prepareVideoAnalysisScriptOptions({projectId:req.params.id,...body}));
});
videoAnalysisRouter.post("/projects/:id/script-options/prepare",prepareOptionsHandler);
videoAnalysisRouter.post("/projects/:id/script-options/validate",prepareOptionsHandler);

videoAnalysisRouter.post("/projects/:id/script-options/:preparedOptionsId/select",safe((req,res)=>{
 const body=z.object({
  selectedOption:z.enum(VIDEO_SCRIPT_OPTION_IDS),
  approved:z.boolean().default(true),
  note:z.string().max(200).optional(),
  settings:editableVideoSettingsSchema.default({})
 }).strict().parse(req.body);
 res.json(savePreparedVideoAnalysisScript({
  projectId:req.params.id,
  preparedOptionsId:req.params.preparedOptionsId,
  selectedOption:body.selectedOption,
  approved:body.approved,
  note:body.note,
  settings:body.settings
 }));
}));

videoAnalysisRouter.put("/projects/:id/script",safe((req,res)=>{
 const body=z.object({
  approved:z.boolean().default(false),
  note:z.string().max(200).optional(),
  script:z.object({
   summary:z.string().max(5000).default(""),
   language:z.string().max(20).default("vi-VN"),
   segments:z.array(segmentSchema).max(500)
  }).strict(),
  settings:editableVideoSettingsSchema.default({})
 }).strict().parse(req.body);
 res.json(saveVideoAnalysisScript({projectId:req.params.id,...body}));
}));

// "đ" không tách được bằng NFKD nên phải thay tay, nếu không tên tệp tiếng Việt sẽ rụng chữ.
const filenameSlug=value=>String(value||"")
 .normalize("NFKD")
 .replace(/[̀-ͯ]/gu,"")
 .replace(/đ/gu,"d")
 .replace(/Đ/gu,"D")
 .replace(/[^A-Za-z0-9]+/gu,"-")
 .replace(/^-+|-+$/gu,"")
 .toLowerCase();

videoAnalysisRouter.get("/projects/:id/subtitles",safe((req,res)=>{
 // buildSubtitleFile tự từ chối định dạng lạ bằng AppError, nên không cần thêm một lớp zod nữa.
 const format=String(req.query.format||"srt").toLowerCase();
 const project=getVideoAnalysisProject(req.params.id);
 const body=buildSubtitleFile(project.script.segments,format);
 const name=`${filenameSlug(project.title)||"phu-de"}.${format}`;
 res.type(format==="vtt"?"text/vtt; charset=utf-8":"application/x-subrip; charset=utf-8");
 res.setHeader("Content-Disposition",`attachment; filename="${name}"`);
 res.send(body);
}));

// Nghe thử giọng đọc một câu cố định. Câu mẫu do server giữ chứ không nhận từ client, để một
// endpoint gọi được API tính phí không thể bị dùng làm cổng đọc văn bản tuỳ ý.
const VOICE_SAMPLE_TEXT="Xin chào, đây là giọng đọc mẫu cho video của bạn.";
const voiceSampleBody=z.object({
 ttsProvider:z.enum(["vertex","gemini","google"]).default("vertex"),
 voice:z.string().min(1).max(100)
}).strict();

videoAnalysisRouter.post("/projects/:id/voice-sample",safe(async(req,res)=>{
 // publicError đã biến ZodError thành 422, nhưng ở đây vẫn tự kiểm để thông báo nói đúng ngôn
 // ngữ của tính năng ("nghe thử") thay vì câu chung cho mọi endpoint.
 const parsed=voiceSampleBody.safeParse(req.body);
 if(!parsed.success){
  const issue=parsed.error.issues[0];
  const field=issue?.path?.join(".")||"body";
  throw new AppError("INVALID_VOICE_SAMPLE_REQUEST",`Yêu cầu nghe thử không hợp lệ ở "${field}": ${issue?.message||"dữ liệu sai"}.`,422);
 }
 const project=getVideoAnalysisProject(req.params.id);
 // Giong cua nha cung cap kia se bi bo qua khi tong hop, nen tu choi thang tai day thay vi im
 // lang doc ra mot giong khac voi thu nguoi dung vua chon.
 const allowed=allowedSampleVoices(project.settings,parsed.data.ttsProvider);
 if(!allowed.includes(parsed.data.voice)){
  throw new AppError("INVALID_VOICE_SAMPLE_REQUEST",`Yêu cầu nghe thử không hợp lệ ở "voice": ${parsed.data.ttsProvider} chỉ đọc được ${allowed.join(", ")}.`,422);
 }
 const settings=voiceSampleSettings(project.settings,parsed.data);
 const clip=await synthesizeCachedSpeech({text:VOICE_SAMPLE_TEXT,settings});
 if(!clip)throw new AppError("VOICE_SAMPLE_FAILED","Không tạo được giọng đọc mẫu.",502);
 const scope={resourceType:"video-analysis",resourceId:project.id};
 res.json({
  url:createSignedMediaUrl(clip.url,scope),
  text:VOICE_SAMPLE_TEXT,
  // Trả về giọng thật sự được đọc để giao diện không nói một đằng phát một nẻo.
  voice:sampledVoiceName(settings),
  cached:clip.cached
 });
}));

videoAnalysisRouter.post("/projects/:id/voice-preview",safe(async(req,res)=>{
 const project=getVideoAnalysisProject(req.params.id);
 if(!project.settings.ttsEnabled)throw new AppError("TTS_DISABLED","Hãy bật TTS trước khi nghe thử.",409);
 const segments=project.script.segments.filter(segment=>segment.enabled!==false);
 // Dùng chung hàm dựng track với luồng render, nên thứ nghe thử khớp đúng bản MP4 sẽ xuất ra.
 const voiceTracks=await buildVoiceTracks({
  settings:project.settings,
  segments,
  mediaScope:{resourceType:"video-analysis",resourceId:project.id}
 });
 if(!voiceTracks.length)throw new AppError("EMPTY_VOICE_SCRIPT","Script chưa có nội dung giọng đọc.",422);
 res.json({voiceTracks});
}));

videoAnalysisRouter.get("/projects/:id/versions",safe((req,res)=>res.json({versions:getVideoAnalysisVersions(req.params.id)})));
videoAnalysisRouter.post("/projects/:id/versions/:versionId/restore",safe((req,res)=>res.json(restoreVideoAnalysisVersion(req.params.id,req.params.versionId))));
videoAnalysisRouter.post("/projects/:id/render-jobs",safe((req,res)=>res.status(202).json(startVideoAnalysisJob(req.params.id))));
videoAnalysisRouter.get("/jobs/:id",safe((req,res)=>res.json(getVideoAnalysisJob(req.params.id))));
videoAnalysisRouter.get("/jobs/:id/download",safe((req,res)=>res.download(getVideoAnalysisFile(req.params.id),`lana-analyzed-video-${req.params.id}.mp4`)));
