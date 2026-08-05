import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import {config} from "./config.js";
import {publicError} from "./errors.js";
import {
  evaluateVideoScriptOptions,
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
  restoreVideoAnalysisVersion,
  saveVideoAnalysisScript,
  videoAnalysisAssetDir
} from "./video-analysis-service.js";
import {getVideoAnalysisFile,getVideoAnalysisJob,startVideoAnalysisJob} from "./video-analysis-jobs.js";

export const videoAnalysisRouter=express.Router();
const safe=handler=>async(req,res)=>{try{await handler(req,res)}catch(error){const response=publicError(error);res.status(response.status).json(response)}};
const ttsSpeedSchema=z.union(VIDEO_TTS_SPEEDS.map(value=>z.literal(value)));
const analysisBriefSchema=z.object({
 contentDomain:z.enum(VIDEO_CONTENT_DOMAINS),
 contentGoal:z.enum(VIDEO_CONTENT_GOALS).nullable().optional(),
 toneStyle:z.enum(VIDEO_TONE_STYLES),
 ttsSpeed:ttsSpeedSchema,
 customContentDomain:z.string().max(200).nullable().optional(),
 customContentGoal:z.string().max(200).nullable().optional()
});
const segmentSchema=z.object({
 id:z.string().optional(),
 start:z.number().min(0),
 end:z.number().positive(),
 subtitleText:z.string().max(2000),
 voiceOverText:z.string().max(4000),
 speaker:z.enum(["speaker1","speaker2"]).default("speaker1"),
 enabled:z.boolean().default(true)
});

videoAnalysisRouter.post("/projects",safe((req,res)=>{
 const body=z.object({
  title:z.string().min(1).max(200),
  sourceUrl:z.string().url().optional(),
  sourceFilename:z.string().max(255).optional(),
  analysisBrief:analysisBriefSchema.nullable().optional()
 }).parse(req.body);
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
 }).parse(req.body);
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

videoAnalysisRouter.post("/projects/:id/script-options/validate",safe((req,res)=>{
 const project=getVideoAnalysisProject(req.params.id);
 const body=z.object({
  options:z.array(z.object({
   optionId:z.enum(VIDEO_SCRIPT_OPTION_IDS),
   label:z.string().min(1).max(200),
   segments:z.array(segmentSchema.pick({id:true,start:true,end:true,subtitleText:true,voiceOverText:true})).max(500)
  })).length(2)
 }).parse(req.body);
 res.json(evaluateVideoScriptOptions({brief:project.settings.analysisBrief,options:body.options}));
}));

videoAnalysisRouter.put("/projects/:id/script",safe((req,res)=>{
 const body=z.object({
  approved:z.boolean().default(false),
  note:z.string().max(200).optional(),
  selectedOption:z.enum(VIDEO_SCRIPT_OPTION_IDS).nullable().optional(),
  script:z.object({
   summary:z.string().max(5000).default(""),
   language:z.string().max(20).default("vi-VN"),
   segments:z.array(segmentSchema).max(500)
  }),
  settings:z.record(z.any()).default({})
 }).parse(req.body);
 const settings=body.selectedOption?{...body.settings,selectedScriptOption:body.selectedOption}:body.settings;
 res.json(saveVideoAnalysisScript({projectId:req.params.id,...body,settings}));
}));

videoAnalysisRouter.get("/projects/:id/versions",safe((req,res)=>res.json({versions:getVideoAnalysisVersions(req.params.id)})));
videoAnalysisRouter.post("/projects/:id/versions/:versionId/restore",safe((req,res)=>res.json(restoreVideoAnalysisVersion(req.params.id,req.params.versionId))));
videoAnalysisRouter.post("/projects/:id/render-jobs",safe((req,res)=>res.status(202).json(startVideoAnalysisJob(req.params.id))));
videoAnalysisRouter.get("/jobs/:id",safe((req,res)=>res.json(getVideoAnalysisJob(req.params.id))));
videoAnalysisRouter.get("/jobs/:id/download",safe((req,res)=>res.download(getVideoAnalysisFile(req.params.id),`lana-analyzed-video-${req.params.id}.mp4`)));
