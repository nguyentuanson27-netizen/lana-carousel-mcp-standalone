import express from "express";
import { z } from "zod";
import { config } from "./config.js";
import { publicError } from "./errors.js";
import { addSlide, createProject, getProject, importAssetFromUrl } from "./service.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/assets", express.static(config.assetDirectory, { fallthrough: false, immutable: true, maxAge: "1y" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

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
