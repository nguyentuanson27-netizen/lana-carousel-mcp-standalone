import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {config} from "./config.js";
import {publicError} from "./errors.js";
import {
  VIDEO_CONTENT_DOMAINS,
  VIDEO_CONTENT_GOALS,
  VIDEO_SCRIPT_OPTION_IDS,
  VIDEO_TONE_STYLES,
  VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";
import {
  attachVideoSource,
  createVideoAnalysisProject,
  getVideoAnalysisProject,
  getVideoAnalysisVersions,
  listVideoAnalysisProjects,
  prepareVideoAnalysisScriptOptions,
  restoreVideoAnalysisVersion,
  savePreparedVideoAnalysisScript,
  saveVideoAnalysisScript,
  videoAnalysisAssetDir
} from "./video-analysis-service.js";
import {getVideoAnalysisFile,getVideoAnalysisJob,startVideoAnalysisJob} from "./video-analysis-jobs.js";

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
 enabled:z.boolean().default(true)
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

videoAnalysisRouter.post("/projects",safe((req,res)=>{
 const body=z.object({
  title:z.string().min(1).max(200),
  sourceUrl:z.string().url().optional(),
  sourceFilename:z.string().max(255).optional(),
  analysisBrief:analysisBriefSchema.nullable().optional()
 }).strict().parse(req.body);
 res.status(201).json(createVideoAnalysisProject(body));
}));

videoAnalysisRouter.get("/projects",safe((_req,res)=>res.json({projects:listVideoAnalysisProjects()})));
videoAnalysisRouter.get("/projects/:id",safe((req,res)=>res.json(getVideoAnalysisProject(req.params.id))));

videoAnalysisRouter.put("/projects/:id/source-reference",safe((req,res)=>{
 const body=z.object({
  url:z.string().url(),
  filename:z.string().max(255).default("video.mp4"),
  mime:z.string().max(100).default("video/mp4"),
  duration:z.number().min(0).default(0)
 }).strict().parse(req.body);
 if(!body.url.startsWith("https://")&&!body.url.startsWith(config.publicBaseUrl))throw new Error("Video reference phải dùng HTTPS.");
 res.json(attachVideoSource({projectId:req.params.id,...body}));
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
  await fs.writeFile(path.join(videoAnalysisAssetDir,name),req.body,{flag:"wx"});
  res.status(201).json(attachVideoSource({
   projectId:req.params.id,
   url:`${config.publicBaseUrl}/video-analysis-assets/${name}`,
   filename:String(req.query.filename||name),
   mime,
   size:req.body.length
  }));
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

videoAnalysisRouter.get("/projects/:id/versions",safe((req,res)=>res.json({versions:getVideoAnalysisVersions(req.params.id)})));
videoAnalysisRouter.post("/projects/:id/versions/:versionId/restore",safe((req,res)=>res.json(restoreVideoAnalysisVersion(req.params.id,req.params.versionId))));
videoAnalysisRouter.post("/projects/:id/render-jobs",safe((req,res)=>res.status(202).json(startVideoAnalysisJob(req.params.id))));
videoAnalysisRouter.get("/jobs/:id",safe((req,res)=>res.json(getVideoAnalysisJob(req.params.id))));
videoAnalysisRouter.get("/jobs/:id/download",safe((req,res)=>res.download(getVideoAnalysisFile(req.params.id),`lana-analyzed-video-${req.params.id}.mp4`)));
