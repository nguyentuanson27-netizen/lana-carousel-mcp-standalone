import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { publicError } from "./errors.js";
import { apiSecurity } from "./api-security.js";
import { consumeApiQuota } from "./api-quota.js";
import { mcpPrincipalBindings } from "./mcp-principal-binding.js";
import { createMcpServer } from "./mcp-tools.js";
import { createProjectAudioAsset, purgeOrphanedProjectAudio, videoAudioDirectory } from "./project-audio.js";
import { getRenderJob, getRenderJobBuffer, startRenderJob } from "./render-jobs.js";
import { deleteVideoRenderJob, getVideoRenderFile, getVideoRenderJob, startVideoRenderJob } from "./video-jobs.js";
import { videoAnalysisAssetDir, purgeExpiredVideoAnalysis } from "./video-analysis-service.js";
import { videoAnalysisRouter } from "./video-analysis-routes.js";
import {
  addSlide, approveProjectContent, approveSlideAsset, approveSlideAssets, cloneProject,
  createProject, deleteProject, extendProject, getApprovedAssetFiles, getProject,
  getProjectVersions, importAssetFromUrl, listProjects, purgeExpiredProjects,
  restoreProjectVersion, updateBrandKit, updateSlideCrop, updateSlideContent,
  updateProjectVideo, updateSlideVideo
} from "./service.js";

const app = express();
const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

app.use(apiSecurity);
app.use(express.json({ limit: "1mb" }));
app.use("/api/video-analysis", videoAnalysisRouter);
app.use("/assets", express.static(config.assetDirectory, { fallthrough: false, immutable: true, maxAge: "1y" }));
app.use("/video-audio", express.static(videoAudioDirectory, { fallthrough: false, maxAge: "7d" }));
app.use("/video-analysis-assets", express.static(videoAnalysisAssetDir, { fallthrough: false, maxAge: "14d" }));
app.use(express.static(publicDirectory, { index: false, maxAge: "5m" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(publicDirectory, "projects.html")));
app.get("/widget", (_req, res) => res.sendFile(path.join(publicDirectory, "widget.html")));
app.get("/projects", (_req, res) => res.sendFile(path.join(publicDirectory, "projects.html")));
app.get("/video-studio", (_req, res) => res.sendFile(path.join(publicDirectory, "video-studio.html")));

const handle = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) { const safe = publicError(error); if (!res.headersSent) res.status(safe.status).json(safe); }
};

app.all("/mcp", handle(async (req, res) => {
  const sessionId = String(req.headers["mcp-session-id"] || "");
  const existing = sessionId ? mcpPrincipalBindings.get(sessionId, req.apiClientId) : null;
  let transport = existing?.transport;
  let server = existing?.server;
  let releaseReservation;
  let initializedSessionId = sessionId;
  let createdHere = false;

  if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
    releaseReservation = mcpPrincipalBindings.reserve(req.apiClientId);
    try {
      consumeApiQuota(req.apiClientId, { mutations: 1, heavy: 0 });
      createdHere = true;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: id => {
          initializedSessionId = id;
          mcpPrincipalBindings.bind(id, req.apiClientId, { transport, server });
          releaseReservation?.();
          releaseReservation = null;
        }
      });
      transport.onclose = () => {
        const detached = mcpPrincipalBindings.detach(transport.sessionId || initializedSessionId);
        detached?.server?.close().catch(() => undefined);
      };
      server = createMcpServer();
      await server.connect(transport);
    } catch (error) {
      releaseReservation?.();
      releaseReservation = null;
      await Promise.allSettled([
        typeof transport?.close === "function" ? transport.close() : Promise.resolve(),
        typeof server?.close === "function" ? server.close() : Promise.resolve()
      ]);
      throw error;
    }
  }

  if (!transport) {
    releaseReservation?.();
    return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session." }, id: null });
  }

  try {
    await transport.handleRequest(req, res, req.body);
  } finally {
    releaseReservation?.();
    if (createdHere && !initializedSessionId) {
      await Promise.allSettled([
        typeof transport?.close === "function" ? transport.close() : Promise.resolve(),
        typeof server?.close === "function" ? server.close() : Promise.resolve()
      ]);
    }
  }
}));

app.post("/api/projects", handle(async (req, res) => {
  const body = z.object({ title: z.string().min(1).max(200), topic: z.string().max(500).optional() }).parse(req.body);
  res.status(201).json(createProject(body));
}));

app.get("/api/projects", handle(async (req, res) => res.json({ projects: listProjects({ search: String(req.query.search || "") }) })));
app.get("/api/projects/:projectId", handle(async (req, res) => res.json(getProject(req.params.projectId))));
app.delete("/api/projects/:projectId", handle(async (req, res) => res.json(await deleteProject(req.params.projectId))));
app.post("/api/projects/:projectId/clone", handle(async (req, res) => res.status(201).json(await cloneProject(req.params.projectId))));
app.post("/api/projects/:projectId/extend", handle(async (req, res) => {
  const body = z.object({ days: z.number().int().min(1).max(90).default(14) }).parse(req.body || {});
  res.json(extendProject(req.params.projectId, body.days));
}));

app.post("/api/projects/:projectId/slides", handle(async (req, res) => {
  const body = z.object({ position: z.number().int().positive(), subject: z.string().min(1), headline: z.string().min(1), body: z.string().min(1) }).parse(req.body);
  res.status(201).json(addSlide({ projectId: req.params.projectId, ...body }));
}));

app.patch("/api/projects/:projectId/brand-kit", handle(async (req, res) => {
  const body = z.object({ font: z.string().min(1).max(100), color: z.string().regex(/^#[0-9A-F]{6}$/iu), applyToAll: z.boolean().default(false) }).parse(req.body);
  res.json(updateBrandKit({ projectId: req.params.projectId, ...body }));
}));
app.get("/api/projects/:projectId/versions", handle(async (req, res) => res.json({ versions: getProjectVersions(req.params.projectId) })));
app.post("/api/projects/:projectId/versions/:versionId/restore", handle(async (req, res) => res.json(restoreProjectVersion(req.params.projectId, req.params.versionId))));
app.post("/api/projects/:projectId/approve-content", handle(async (req, res) => res.json(approveProjectContent(req.params.projectId))));

app.post("/api/projects/:projectId/slides/:slideId/approve-asset", handle(async (req, res) => {
  const { assetId } = z.object({ assetId: z.string().uuid() }).parse(req.body);
  res.json(approveSlideAsset({ projectId: req.params.projectId, slideId: req.params.slideId, assetId }));
}));
app.post("/api/projects/:projectId/slides/:slideId/approve-assets", handle(async (req, res) => {
  const body = z.object({ assetIds: z.array(z.string().uuid()).min(1).max(10), mode: z.enum(["crop", "grid"]) }).parse(req.body);
  res.json(approveSlideAssets({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
}));

const textLayerSchema = z.object({
  id: z.string().max(100).optional(), role: z.enum(["headline", "body", "custom"]).optional(),
  content: z.string().max(500), enabled: z.boolean().default(true), font: z.string().min(1).max(100),
  size: z.number().min(24).max(220), x: z.number().min(3).max(97), y: z.number().min(3).max(97),
  color: z.string().regex(/^#[0-9A-F]{6}$/iu), align: z.enum(["left", "center", "right"]),
  opacity: z.number().min(.1).max(1).default(1), rotation: z.number().min(-180).max(180).default(0),
  boxEnabled: z.boolean().optional(), boxColor: z.string().regex(/^#[0-9A-F]{6}$/iu).optional(),
  boxOpacity: z.number().min(0).max(1).optional(), boxBorderColor: z.string().regex(/^#[0-9A-F]{6}$/iu).optional(),
  boxBorderWidth: z.number().min(0).max(40).optional(), boxBorderOpacity: z.number().min(0).max(1).optional(),
  boxRadius: z.number().min(0).max(120).optional(), boxPaddingX: z.number().min(0).max(120).optional(),
  boxPaddingY: z.number().min(0).max(80).optional(), boxWidth: z.number().min(20).max(96).optional(),
  weight: z.enum(["400", "500", "600", "700", "800", "900"]).optional(), underline: z.boolean().optional(),
  sizeRanges: z.array(z.object({ start: z.number().int().min(0).max(500), end: z.number().int().min(0).max(500), size: z.number().min(24).max(220) })).max(30).optional(),
  styleRanges: z.array(z.object({ start: z.number().int().min(0).max(500), end: z.number().int().min(0).max(500), size: z.number().min(24).max(220).optional(), font: z.string().min(1).max(100).optional(), color: z.string().regex(/^#[0-9A-F]{6}$/iu).optional(), weight: z.enum(["400", "500", "600", "700", "800", "900"]).optional(), underline: z.boolean().optional() })).max(60).optional()
});

app.patch("/api/projects/:projectId/slides/:slideId/content", handle(async (req, res) => {
  const body = z.object({
    headline: z.string().min(1).max(300), body: z.string().min(1).max(2000), textEnabled: z.boolean(),
    overlayText: z.string().max(500), textFont: z.string().min(1).max(100), textSize: z.number().int().min(24).max(220),
    textPosition: z.enum(["top", "center", "bottom"]), textColor: z.string().regex(/^#[0-9A-F]{6}$/iu),
    textAlign: z.enum(["left", "center", "right"]), textX: z.number().min(5).max(95), textY: z.number().min(5).max(95),
    textLayers: z.array(textLayerSchema).max(10).default([])
  }).parse(req.body);
  res.json(updateSlideContent({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
}));

app.patch("/api/projects/:projectId/slides/:slideId/crop", handle(async (req, res) => {
  const body = z.object({
    cropX: z.number().min(0).max(100), cropY: z.number().min(0).max(100), cropZoom: z.number().min(1).max(3),
    imageBrightness: z.number().min(.3).max(2).optional(), imageContrast: z.number().min(.3).max(2).optional(),
    imageSaturation: z.number().min(0).max(2).optional(), imageBlur: z.number().min(0).max(20).optional(),
    imageGrayscale: z.number().min(0).max(1).optional(), frameInset: z.number().int().min(0).max(360).optional(),
    frameWidth: z.number().int().min(0).max(80).optional(), frameColor: z.string().regex(/^#[0-9A-F]{6}$/iu).optional(),
    frameOpacity: z.number().min(0).max(1).optional(), frameRadius: z.number().int().min(0).max(240).optional()
  }).parse(req.body);
  res.json(updateSlideCrop({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
}));

app.post("/api/projects/:projectId/slides/:slideId/assets/import-url", handle(async (req, res) => {
  const body = z.object({
    image_url: z.string().url(), source_page_url: z.string().url().optional(), source_title: z.string().max(500).optional(),
    source_publisher: z.string().max(200).optional(), source_type: z.enum(["official_brand", "official_social", "news", "magazine", "unknown"]).optional(),
    alt_text: z.string().max(500).optional(), force_replace: z.boolean().optional(), select_asset: z.boolean().optional()
  }).parse(req.body);
  const result = await importAssetFromUrl({ projectId: req.params.projectId, slideId: req.params.slideId, imageUrl: body.image_url, sourcePageUrl: body.source_page_url, sourceTitle: body.source_title, sourcePublisher: body.source_publisher, sourceType: body.source_type, altText: body.alt_text, forceReplace: body.force_replace || false, selectAsset: body.select_asset });
  res.status(result.candidateAdded ? 201 : 200).json(result);
}));

app.post("/api/projects/:projectId/video-audio", express.raw({ type: ["audio/mpeg", "audio/mp3", "application/octet-stream"], limit: "25mb" }), handle(async (req, res) => {
  getProject(req.params.projectId);
  if (!Buffer.isBuffer(req.body) || req.body.length < 128) throw new Error("File MP3 rỗng hoặc không hợp lệ.");
  const header = req.body.subarray(0, 3).toString("ascii"), isId3 = header === "ID3", isFrame = req.body[0] === 0xff && (req.body[1] & 0xe0) === 0xe0;
  if (!isId3 && !isFrame) throw new Error("Chỉ chấp nhận file MP3 hợp lệ.");
  const uploaded = await createProjectAudioAsset({ projectId: req.params.projectId, buffer: req.body, mimeType: "audio/mpeg" });
  res.status(201).json({ url: uploaded.url, size: uploaded.size });
}));

const projectVideoSchema = z.object({
  aspectRatio: z.enum(["vertical", "square", "landscape"]).default("vertical"), fps: z.number().int().min(24).max(60).default(30),
  defaultSceneDuration: z.number().min(.5).max(15).default(3), transition: z.enum(["cut", "fade", "slide", "zoom"]).default("fade"),
  motion: z.enum(["none", "zoom-in", "zoom-out", "pan-left", "pan-right", "ken-burns", "smart-ken-burns"]).default("zoom-in"),
  textAnimation: z.enum(["none", "hidden", "static", "block", "by-line", "by-word", "typewriter"]).default("none"),
  audioUrl: z.union([z.string().url(), z.literal("")]).default(""), audioVolume: z.number().min(0).max(1).default(.6),
  subtitles: z.boolean().default(false), beatSync: z.boolean().default(false), bpm: z.number().min(40).max(240).default(120),
  ttsEnabled: z.boolean().default(false), ttsProvider: z.enum(["google", "gemini", "vertex"]).default("google"),
  ttsVoice: z.string().max(100).default("vi-VN-Neural2-D"), ttsSpeed: z.number().min(.5).max(2).default(1), ttsVolume: z.number().min(0).max(1).default(1),
  geminiModel: z.string().max(100).default("gemini-2.5-flash-tts"), geminiMultiSpeaker: z.boolean().default(false),
  geminiSpeaker1Name: z.string().min(1).max(50).default("Nguoi dan"), geminiSpeaker1Voice: z.string().min(1).max(50).default("Kore"),
  geminiSpeaker2Name: z.string().min(1).max(50).default("Khach moi"), geminiSpeaker2Voice: z.string().min(1).max(50).default("Puck"),
  geminiStylePrompt: z.string().max(500).default(""), autoTiming: z.boolean().default(true), smartKenBurns: z.boolean().default(true),
  kenBurnsIntensity: z.number().min(.04).max(.35).default(.14), subtitleStyle: z.enum(["static", "karaoke", "word", "pop"]).default("karaoke"),
  subtitlePosition: z.number().min(55).max(94).default(88), subtitleFont: z.string().max(100).default("TikTok Sans"),
  subtitleColor: z.string().regex(/^#[0-9A-F]{6}$/iu).default("#FFFFFF"), subtitleBackgroundColor: z.string().regex(/^#[0-9A-F]{6}$/iu).default("#000000"),
  subtitleBackgroundOpacity: z.number().min(0).max(1).default(.72), subtitleSize: z.number().min(20).max(96).default(38),
  showSlideTitle: z.boolean().default(false), layerStagger: z.number().min(0).max(1).default(.12), preset: z.enum(["fashion", "tiktok", "minimal", "editorial"]).default("fashion")
}).partial();

app.patch("/api/projects/:projectId/video", handle(async (req, res) => {
  const settings = projectVideoSchema.parse(req.body.settings || {});
  res.json(updateProjectVideo({ projectId: req.params.projectId, enabled: Boolean(req.body.enabled), settings }));
}));

const sceneVideoSchema = z.object({
  enabled: z.boolean(), order: z.number().int().min(0).max(100), duration: z.number().min(.5).max(15),
  motion: z.enum(["none", "zoom-in", "zoom-out", "pan-left", "pan-right", "ken-burns", "smart-ken-burns"]),
  transition: z.enum(["cut", "fade", "slide", "zoom"]), textAnimation: z.enum(["none", "hidden", "static", "block", "by-line", "by-word", "typewriter"]),
  subtitles: z.boolean(), caption: z.string().max(500), speaker: z.enum(["speaker1", "speaker2"]),
  layerAnimations: z.record(z.string(), z.enum(["none", "hidden", "static", "block", "by-line", "by-word", "typewriter"])),
  focusX: z.number().min(0).max(100), focusY: z.number().min(0).max(100), kenBurnsIntensity: z.number().min(.04).max(.35),
  subtitleStyle: z.enum(["static", "karaoke", "word", "pop"]), subtitlePosition: z.number().min(55).max(94),
  subtitleFont: z.string().max(100), subtitleColor: z.string().regex(/^#[0-9A-F]{6}$/iu), subtitleBackgroundColor: z.string().regex(/^#[0-9A-F]{6}$/iu),
  subtitleBackgroundOpacity: z.number().min(0).max(1), subtitleSize: z.number().min(20).max(96), showSlideTitle: z.boolean()
}).partial();

app.patch("/api/projects/:projectId/slides/:slideId/video", handle(async (req, res) => {
  const settings = sceneVideoSchema.parse(req.body);
  res.json(updateSlideVideo({ projectId: req.params.projectId, slideId: req.params.slideId, settings }));
}));
app.post("/api/projects/:projectId/video-render-jobs", handle(async (req, res) => res.status(202).json(startVideoRenderJob(req.params.projectId))));
app.get("/api/video-render-jobs/:jobId", handle(async (req, res) => res.json(getVideoRenderJob(req.params.jobId))));
app.get("/api/video-render-jobs/:jobId/download", handle(async (req, res) => res.download(getVideoRenderFile(req.params.jobId), `lana-video-${req.params.jobId}.mp4`)));
app.delete("/api/video-render-jobs/:jobId", handle(async (req, res) => res.json(await deleteVideoRenderJob(req.params.jobId))));

app.post("/api/projects/:projectId/render-jobs", handle(async (req, res) => { getProject(req.params.projectId); res.status(202).json(startRenderJob(req.params.projectId)); }));
app.get("/api/render-jobs/:jobId", handle(async (req, res) => res.json(getRenderJob(req.params.jobId))));
app.get("/api/render-jobs/:jobId/download", handle(async (req, res) => {
  const result = getRenderJobBuffer(req.params.jobId);
  res.attachment(`lana-carousel-${result.projectId}.zip`).send(result.buffer);
}));
app.get("/api/projects/:projectId/download-images.zip", handle(async (req, res) => {
  const files = await getApprovedAssetFiles(req.params.projectId);
  res.attachment(`lana-carousel-${req.params.projectId}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", error => res.destroy(error));
  archive.pipe(res);
  for (const file of files) archive.append(file.buffer, { name: file.name });
  await archive.finalize();
}));

app.listen(config.port, () => console.log(`Lana Carousel HTTP server: ${config.publicBaseUrl}`));
purgeOrphanedProjectAudio().catch(error => console.error("Initial project audio cleanup failed", error));
purgeExpiredProjects().catch(error => console.error("Initial project expiry cleanup failed", error));
purgeExpiredVideoAnalysis().catch(error => console.error("Initial video analysis cleanup failed", error));
const expiryTimer = setInterval(() => purgeExpiredProjects().catch(error => console.error("Scheduled project expiry cleanup failed", error)), 6 * 60 * 60 * 1000);
expiryTimer.unref();
