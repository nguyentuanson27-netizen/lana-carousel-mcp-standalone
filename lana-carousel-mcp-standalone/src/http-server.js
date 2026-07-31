import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { publicError } from "./errors.js";
import { createMcpServer } from "./mcp-tools.js";
import { getRenderJob, getRenderJobBuffer, startRenderJob } from "./render-jobs.js";
import { getVideoRenderFile, getVideoRenderJob, startVideoRenderJob } from "./video-jobs.js";
import {
  addSlide,
  approveProjectContent,
  approveSlideAsset,
  approveSlideAssets,
  cloneProject,
  createProject,
  deleteProject,
  extendProject,
  getApprovedAssetFiles,
  getProject,
  getProjectVersions,
  importAssetFromUrl,
  listProjects,
  purgeExpiredProjects,
  restoreProjectVersion,
  updateBrandKit,
  updateSlideCrop,
  updateSlideContent,
  updateProjectVideo,
  updateSlideVideo
} from "./service.js";

const app = express();
const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
app.use(express.json({ limit: "1mb" }));
app.use("/assets", express.static(config.assetDirectory, { fallthrough: false, immutable: true, maxAge: "1y" }));
app.use(express.static(publicDirectory, { index: false, maxAge: "5m" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/widget", (_req, res) => res.sendFile(path.join(publicDirectory, "widget.html")));
app.get("/projects", (_req, res) => res.sendFile(path.join(publicDirectory, "projects.html")));

const mcpTransports = new Map();

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId ? mcpTransports.get(sessionId) : undefined;

    if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
      let server;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          mcpTransports.set(id, transport);
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) mcpTransports.delete(transport.sessionId);
        server?.close().catch(() => {});
      };
      server = createMcpServer();
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing or invalid MCP session." },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const body = z.object({ title: z.string().min(1).max(200), topic: z.string().max(500).optional() }).parse(req.body);
    res.status(201).json(createProject(body));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.post("/api/projects/:projectId/slides", async (req, res) => {
  try {
    const body = z.object({ position: z.number().int().positive(), subject: z.string().min(1), headline: z.string().min(1), body: z.string().min(1) }).parse(req.body);
    res.status(201).json(addSlide({ projectId: req.params.projectId, ...body }));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  try {
    res.json(getProject(req.params.projectId));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.get("/api/projects", (req, res) => {
  try { res.json({ projects: listProjects({ search: String(req.query.search || "") }) }); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.delete("/api/projects/:projectId", async (req, res) => {
  try { res.json(await deleteProject(req.params.projectId)); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.post("/api/projects/:projectId/clone", async (req, res) => {
  try { res.status(201).json(await cloneProject(req.params.projectId)); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.post("/api/projects/:projectId/extend", (req, res) => {
  try { const body = z.object({ days: z.number().int().min(1).max(90).default(14) }).parse(req.body || {}); res.json(extendProject(req.params.projectId, body.days)); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.patch("/api/projects/:projectId/brand-kit", (req, res) => {
  try {
    const body = z.object({ font: z.string().min(1).max(100), color: z.string().regex(/^#[0-9A-F]{6}$/i), applyToAll: z.boolean().default(false) }).parse(req.body);
    res.json(updateBrandKit({ projectId: req.params.projectId, ...body }));
  } catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.get("/api/projects/:projectId/versions", (req, res) => {
  try { res.json({ versions: getProjectVersions(req.params.projectId) }); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.post("/api/projects/:projectId/versions/:versionId/restore", (req, res) => {
  try { res.json(restoreProjectVersion(req.params.projectId, req.params.versionId)); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.post("/api/projects/:projectId/approve-content", (req, res) => {
  try {
    res.json(approveProjectContent(req.params.projectId));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.post("/api/projects/:projectId/slides/:slideId/approve-asset", (req, res) => {
  try {
    const body = z.object({ assetId: z.string().uuid() }).parse(req.body);
    res.json(approveSlideAsset({
      projectId: req.params.projectId,
      slideId: req.params.slideId,
      assetId: body.assetId
    }));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.post("/api/projects/:projectId/slides/:slideId/approve-assets", (req, res) => {
  try {
    const body = z.object({ assetIds: z.array(z.string().uuid()).min(1).max(10), mode: z.enum(["crop", "grid"]) }).parse(req.body);
    res.json(approveSlideAssets({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.patch("/api/projects/:projectId/slides/:slideId/content", (req, res) => {
  try {
    const body = z.object({
      headline: z.string().min(1).max(300), body: z.string().min(1).max(2000),
      textEnabled: z.boolean(), overlayText: z.string().max(500),
      textFont: z.enum(["TikTok Sans", "Montserrat", "Poppins", "Bebas Neue", "Roboto", "Playfair Display", "Courier New"]),
      textSize: z.number().int().min(24).max(220), textPosition: z.enum(["top", "center", "bottom"]),
      textColor: z.string().regex(/^#[0-9A-F]{6}$/i), textAlign: z.enum(["left", "center", "right"]),
      textX: z.number().min(5).max(95), textY: z.number().min(5).max(95),
      textLayers: z.array(z.object({
        id: z.string().max(100).optional(), role: z.enum(["headline", "body", "custom"]).optional(),
        content: z.string().max(500), enabled: z.boolean().default(true),
        font: z.string().min(1).max(100), size: z.number().min(24).max(220),
        x: z.number().min(3).max(97), y: z.number().min(3).max(97), color: z.string().regex(/^#[0-9A-F]{6}$/i),
        align: z.enum(["left", "center", "right"]), opacity: z.number().min(0.1).max(1).default(1),
        rotation: z.number().min(-180).max(180).default(0),
        boxEnabled: z.boolean().optional(), boxColor: z.string().regex(/^#[0-9A-F]{6}$/i).optional(),
        boxOpacity: z.number().min(0).max(1).optional(),
        boxBorderColor: z.string().regex(/^#[0-9A-F]{6}$/i).optional(),
        boxBorderWidth: z.number().min(0).max(40).optional(),
        boxBorderOpacity: z.number().min(0).max(1).optional(),
        boxRadius: z.number().min(0).max(120).optional(),
        boxPaddingX: z.number().min(0).max(120).optional(),
        boxPaddingY: z.number().min(0).max(80).optional(),
        boxWidth: z.number().min(20).max(96).optional(),
        weight: z.enum(["400", "500", "600", "700", "800", "900"]).optional(),
        underline: z.boolean().optional(),
        sizeRanges: z.array(z.object({
          start: z.number().int().min(0).max(500),
          end: z.number().int().min(0).max(500),
          size: z.number().min(24).max(220)
        })).max(30).optional(),
        styleRanges: z.array(z.object({
          start: z.number().int().min(0).max(500),
          end: z.number().int().min(0).max(500),
          size: z.number().min(24).max(220).optional(),
          font: z.string().min(1).max(100).optional(),
          color: z.string().regex(/^#[0-9A-F]{6}$/i).optional(),
          weight: z.enum(["400", "500", "600", "700", "800", "900"]).optional(),
          underline: z.boolean().optional()
        })).max(60).optional()
      })).max(10).default([])
    }).parse(req.body);
    res.json(updateSlideContent({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.patch("/api/projects/:projectId/slides/:slideId/crop", (req, res) => {
  try {
    const body = z.object({
      cropX: z.number().min(0).max(100), cropY: z.number().min(0).max(100), cropZoom: z.number().min(1).max(3),
      imageBrightness: z.number().min(0.3).max(2).optional(),
      imageContrast: z.number().min(0.3).max(2).default(1),
      imageSaturation: z.number().min(0).max(2).optional(),
      imageBlur: z.number().min(0).max(20).optional(),
      imageGrayscale: z.number().min(0).max(1).optional(),
      frameInset: z.number().int().min(0).max(360).optional(),
      frameWidth: z.number().int().min(0).max(80).optional(),
      frameColor: z.string().regex(/^#[0-9A-F]{6}$/i).optional(),
      frameOpacity: z.number().min(0).max(1).optional(),
      frameRadius: z.number().int().min(0).max(240).optional()
    }).parse(req.body);
    res.json(updateSlideCrop({ projectId: req.params.projectId, slideId: req.params.slideId, ...body }));
  } catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});


app.patch("/api/projects/:projectId/video", (req,res)=>{try{const settings=z.object({aspectRatio:z.enum(["vertical","square","landscape"]).default("vertical"),fps:z.number().int().min(24).max(60).default(30),defaultSceneDuration:z.number().min(.5).max(15).default(3),transition:z.enum(["cut","fade","slide","zoom"]).default("fade"),motion:z.enum(["none","zoom-in","zoom-out","pan-left","pan-right","ken-burns"]).default("zoom-in"),textAnimation:z.enum(["none","block","by-line","by-word","typewriter"]).default("none"),audioUrl:z.union([z.string().url(),z.literal("")]).default(""),audioVolume:z.number().min(0).max(1).default(.6),subtitles:z.boolean().default(false),beatSync:z.boolean().default(false),bpm:z.number().min(40).max(240).default(120),ttsEnabled:z.boolean().default(false),ttsProvider:z.enum(["google","gemini","vertex"]).default("google"),ttsVoice:z.string().max(100).default("vi-VN-Neural2-D"),ttsSpeed:z.number().min(.5).max(2).default(1),ttsVolume:z.number().min(0).max(1).default(1),geminiModel:z.enum(["gemini-3.1-flash-tts-preview","gemini-2.5-flash-tts","gemini-2.5-pro-tts","gemini-2.5-flash-preview-tts","gemini-2.5-pro-preview-tts"]).default("gemini-2.5-flash-tts"),geminiMultiSpeaker:z.boolean().default(false),geminiSpeaker1Name:z.string().min(1).max(50).default("Nguoi dan"),geminiSpeaker1Voice:z.string().min(1).max(50).default("Kore"),geminiSpeaker2Name:z.string().min(1).max(50).default("Khach moi"),geminiSpeaker2Voice:z.string().min(1).max(50).default("Puck"),geminiStylePrompt:z.string().max(500).default(""),preset:z.enum(["fashion","tiktok","minimal","editorial"]).default("fashion")}).parse(req.body.settings||{});res.json(updateProjectVideo({projectId:req.params.projectId,enabled:Boolean(req.body.enabled),settings}));}catch(error){const safe=publicError(error);res.status(safe.status).json(safe);}});
app.patch("/api/projects/:projectId/slides/:slideId/video",(req,res)=>{try{const settings=z.object({enabled:z.boolean().default(true),order:z.number().int().min(0).max(100),duration:z.number().min(.5).max(15),motion:z.enum(["none","zoom-in","zoom-out","pan-left","pan-right","ken-burns"]),transition:z.enum(["cut","fade","slide","zoom"]),textAnimation:z.enum(["none","block","by-line","by-word","typewriter"]),subtitles:z.boolean(),caption:z.string().max(500),speaker:z.enum(["speaker1","speaker2"])}).partial().parse(req.body);res.json(updateSlideVideo({projectId:req.params.projectId,slideId:req.params.slideId,settings}));}catch(error){const safe=publicError(error);res.status(safe.status).json(safe);}});
app.post("/api/projects/:projectId/video-render-jobs",(req,res)=>{try{res.status(202).json(startVideoRenderJob(req.params.projectId));}catch(error){const safe=publicError(error);res.status(safe.status).json(safe);}});
app.get("/api/video-render-jobs/:jobId",(req,res)=>{try{res.json(getVideoRenderJob(req.params.jobId));}catch(error){const safe=publicError(error);res.status(safe.status).json(safe);}});
app.get("/api/video-render-jobs/:jobId/download",(req,res)=>{try{res.download(getVideoRenderFile(req.params.jobId),"lana-video-"+req.params.jobId+".mp4");}catch(error){const safe=publicError(error);res.status(safe.status).json(safe);}});

app.post("/api/projects/:projectId/render-jobs", (req, res) => {
  try { getProject(req.params.projectId); res.status(202).json(startRenderJob(req.params.projectId)); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.get("/api/render-jobs/:jobId", (req, res) => {
  try { res.json(getRenderJob(req.params.jobId)); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.get("/api/render-jobs/:jobId/download", (req, res) => {
  try { const result = getRenderJobBuffer(req.params.jobId); res.attachment(`lana-carousel-${result.projectId}.zip`).send(result.buffer); }
  catch (error) { const safe = publicError(error); res.status(safe.status).json(safe); }
});

app.get("/api/projects/:projectId/download-images.zip", async (req, res) => {
  try {
    const files = await getApprovedAssetFiles(req.params.projectId);
    res.attachment(`lana-carousel-${req.params.projectId}.zip`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", error => {
      if (!res.headersSent) {
        const safe = publicError(error); res.status(safe.status).json(safe);
      } else {
        res.destroy(error);
      }
    });
    archive.pipe(res);
    for (const file of files) archive.append(file.buffer, { name: file.name });
    archive.finalize();
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.post("/api/projects/:projectId/slides/:slideId/assets/import-url", async (req, res) => {
  try {
    const body = z.object({
      image_url: z.string().url(),
      source_page_url: z.string().url().optional(),
      source_title: z.string().max(500).optional(),
      source_publisher: z.string().max(200).optional(),
      source_type: z.enum(["official_brand", "official_social", "news", "magazine", "unknown"]).optional(),
      alt_text: z.string().max(500).optional(),
      force_replace: z.boolean().optional()
    }).parse(req.body);
    const result = await importAssetFromUrl({
      projectId: req.params.projectId,
      slideId: req.params.slideId,
      imageUrl: body.image_url,
      sourcePageUrl: body.source_page_url,
      sourceTitle: body.source_title,
      sourcePublisher: body.source_publisher,
      sourceType: body.source_type,
      altText: body.alt_text,
      forceReplace: body.force_replace || false
    });
    res.status(201).json(result);
  } catch (error) {
    const safe = publicError(error); res.status(safe.status).json(safe);
  }
});

app.listen(config.port, () => {
  console.log(`Lana Carousel HTTP server: ${config.publicBaseUrl}`);
});

purgeExpiredProjects().catch(error => console.error("Initial project expiry cleanup failed", error));
const expiryTimer = setInterval(() => {
  purgeExpiredProjects().catch(error => console.error("Scheduled project expiry cleanup failed", error));
}, 6 * 60 * 60 * 1000);
expiryTimer.unref();
