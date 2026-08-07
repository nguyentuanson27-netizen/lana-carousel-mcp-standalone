import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { sql } from "./db.js";
import { getProject, renderSlideSnapshot } from "./service.js";
import { projectAudioFileForProject } from "./project-audio.js";
import { generateVideoTtsTrack } from "./video-tts.js";
import { downloadRemoteAudio, isTrustedUploadedAudioUrl } from "./remote-media.js";

const queue = [];
const activeJobs = new Map();
let running = false;
let bundlePromise;
const outputDir = path.resolve(path.dirname(config.databasePath), "video-renders");
const videoRetentionMs = 7 * 864e5;
const videoDimensions = {
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  landscape: { width: 1920, height: 1080 }
};

export function videoDimensionsForAspect(aspectRatio) {
  return videoDimensions[aspectRatio] || videoDimensions.vertical;
}

const publicJob = row => ({
  id: row.id, projectId: row.project_id, status: row.status, progress: row.progress,
  error: row.error, createdAt: row.created_at, completedAt: row.completed_at,
  expiresAt: new Date(new Date(row.created_at).getTime() + videoRetentionMs).toISOString(),
  downloadUrl: row.status === "READY" ? `${config.publicBaseUrl}/api/video-render-jobs/${row.id}/download` : null
});

function updateJob(job, patch) {
  Object.assign(job, patch);
  sql.updateVideoJob.run({
    id: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error || null,
    output_path: job.output_path || null,
    updated_at: new Date().toISOString(),
    completed_at: job.completed_at || null
  });
}

function preflight(project) {
  if (!project.videoEnabled) throw new AppError("VIDEO_NOT_ENABLED", "Hãy bật video trước khi render.", 409);
  if (project.contentStatus !== "APPROVED") throw new AppError("CONTENT_NOT_APPROVED", "Cần duyệt nội dung trước khi render video.", 409);
  if (project.imageStatus !== "APPROVED") throw new AppError("IMAGES_NOT_APPROVED", "Cần duyệt toàn bộ ảnh trước khi render video.", 409);
  if (!project.slides.length) throw new AppError("EMPTY_PROJECT", "Carousel chưa có slide để tạo video.", 409);
  const active = project.slides.filter(slide => (slide.video || {}).enabled !== false && slide.selectedAssetId && slide.imageApproved);
  if (!active.length) throw new AppError("NO_ACTIVE_SCENES", "Hãy bật ít nhất một scene đã duyệt ảnh.", 409);
  return active;
}

export function orderedRenderableSlides(project) {
  return preflight(project)
    .map((slide, index) => ({ slide, order: Number((slide.video || {}).order ?? index) }))
    .sort((left, right) => left.order - right.order)
    .map(item => item.slide);
}

function textLayersForScene(slide, settings, cfg, preset) {
  const source = slide.textLayers?.length ? slide.textLayers : (slide.textEnabled ? [{
    id: "legacy-primary", role: "headline", content: slide.overlayText || slide.headline,
    enabled: true, font: slide.textFont, size: slide.textSize, x: slide.textX,
    y: slide.textY, color: slide.textColor, align: slide.textAlign
  }] : []);
  return source.map((layer, layerIndex) => ({
    ...layer,
    animation: settings.layerAnimations?.[layer.id] || settings.layerAnimations?.[String(layerIndex)] || layer.animation || settings.textAnimation || cfg.textAnimation || preset.textAnimation || "none",
    animationDelay: Number(layer.animationDelay ?? layerIndex * (cfg.layerStagger ?? .12))
  }));
}

export async function buildVideoProps(project) {
  const cfg = project.videoSettings || {};
  const preset = {
    fashion: { motion: "zoom-in", transition: "fade", textAnimation: "block" },
    tiktok: { motion: "ken-burns", transition: "cut", textAnimation: "by-word" },
    minimal: { motion: "none", transition: "fade", textAnimation: "block" },
    editorial: { motion: "pan-left", transition: "fade", textAnimation: "by-line" }
  }[cfg.preset] || {};
  const aspectRatio = cfg.aspectRatio || "vertical";
  const dimensions = videoDimensionsForAspect(aspectRatio);
  const slides = orderedRenderableSlides(project);
  const scenes = await Promise.all(slides.map(async (slide, index) => {
    const settings = slide.video || {};
    let duration = Number(settings.duration || cfg.defaultSceneDuration || 3);
    if (cfg.beatSync && cfg.bpm) duration = Math.max(.5, Math.round(duration / (60 / cfg.bpm)) * (60 / cfg.bpm));
    const backgroundSlide = { ...slide, textEnabled: false, textLayers: [] };
    const rendered = await renderSlideSnapshot(backgroundSlide, project.assets, dimensions);
    return {
      id: slide.id,
      enabled: true,
      order: Number(settings.order ?? index),
      duration,
      motion: settings.motion || cfg.motion || preset.motion || "zoom-in",
      transition: settings.transition || cfg.transition || preset.transition || "fade",
      textAnimation: settings.textAnimation || cfg.textAnimation || preset.textAnimation || "none",
      subtitles: settings.subtitles ?? cfg.subtitles ?? false,
      subtitleStyle: settings.subtitleStyle || cfg.subtitleStyle || "karaoke",
      subtitlePosition: Number(settings.subtitlePosition ?? cfg.subtitlePosition ?? 88),
      subtitleFont: settings.subtitleFont || cfg.subtitleFont || "TikTok Sans",
      subtitleColor: settings.subtitleColor || cfg.subtitleColor || "#FFFFFF",
      subtitleBackgroundColor: settings.subtitleBackgroundColor || cfg.subtitleBackgroundColor || "#000000",
      subtitleBackgroundOpacity: Number(settings.subtitleBackgroundOpacity ?? cfg.subtitleBackgroundOpacity ?? .72),
      subtitleSize: Number(settings.subtitleSize ?? cfg.subtitleSize ?? 38),
      showSlideTitle: settings.showSlideTitle ?? cfg.showSlideTitle ?? false,
      caption: settings.caption ?? slide.body ?? "",
      headline: slide.headline,
      body: slide.body,
      textLayers: textLayersForScene(slide, settings, cfg, preset),
      imageUrl: `data:image/webp;base64,${rendered.toString("base64")}`,
      focusX: Number(settings.focusX ?? slide.cropX ?? 50),
      focusY: Number(settings.focusY ?? slide.cropY ?? 50),
      kenBurnsIntensity: Number(settings.kenBurnsIntensity ?? cfg.kenBurnsIntensity ?? .14)
    };
  }));
  return {
    scenes,
    audioUrl: "",
    audioVolume: Number(cfg.audioVolume ?? .6),
    voiceUrl: "",
    voiceVolume: Number(cfg.ttsVolume ?? 1),
    voicePlaybackRate: Number(cfg.ttsSpeed ?? 1),
    aspectRatio,
    fps: Number(cfg.fps || 30)
  };
}

function mimeForFile(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if ([".m4a", ".mp4"].includes(extension)) return "audio/mp4";
  return "audio/mpeg";
}

export async function audioDataUrl(project, tempFiles = []) {
  const raw = String(project.videoSettings?.audioUrl || "").trim();
  if (!raw) return "";
  let file;
  if (isTrustedUploadedAudioUrl(raw)) {
    file = (await projectAudioFileForProject(project.id, raw)).absolutePath;
  } else {
    const downloaded = await downloadRemoteAudio(raw, path.join(outputDir, "audio-cache"));
    file = downloaded.file;
    tempFiles.push(file);
  }
  const buffer = await fs.readFile(file);
  return `data:${mimeForFile(file)};base64,${buffer.toString("base64")}`;
}

function friendlyVideoError(error) {
  const message = String(error?.message || "Render video thất bại");
  if (/ffprobe|remotion-assets-dir|Command failed/iu.test(message)) return "Không đọc được file media đầu vào.";
  return message.slice(0, 500);
}

async function serveUrl() {
  bundlePromise ??= bundle({ entryPoint: path.resolve("video/index.jsx") });
  return bundlePromise;
}

async function work(job) {
  const tempFiles = [];
  activeJobs.set(job.id, job);
  try {
    if (job.cancelled) return;
    updateJob(job, { status: "RENDERING", progress: 5, error: null });
    await fs.mkdir(outputDir, { recursive: true });
    const project = JSON.parse(job.snapshot);
    const orderedSlides = orderedRenderableSlides(project);
    const inputProps = await buildVideoProps(project);
    inputProps.audioUrl = await audioDataUrl(project, tempFiles);

    if (project.videoSettings?.ttsEnabled) {
      const ttsProject = { ...project, slides: orderedSlides };
      const track = await generateVideoTtsTrack(ttsProject, project.videoSettings);
      inputProps.voiceUrl = track.dataUrl;
      if (project.videoSettings.autoTiming !== false && track.durationSeconds) {
        const weights = inputProps.scenes.map(scene => Math.max(1, String(scene.caption || scene.body || scene.headline || "").replace(/\s+/gu, "").length));
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
        const target = track.durationSeconds / Math.max(.5, inputProps.voicePlaybackRate);
        inputProps.scenes.forEach((scene, index) => { scene.duration = Math.max(.8, Math.min(15, target * weights[index] / totalWeight)); });
      }
    }

    if (job.cancelled) return;
    const url = await serveUrl();
    updateJob(job, { progress: 20 });
    const composition = await selectComposition({ serveUrl: url, id: "LanaCarouselVideo", inputProps, browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || undefined });
    const output = path.join(outputDir, `${job.id}.mp4`);
    let lastProgress = 20;
    await renderMedia({
      composition, serveUrl: url, codec: "h264", outputLocation: output, inputProps,
      concurrency: 1, crf: 20, chromiumOptions: { disableWebSecurity: false },
      onProgress: ({ progress }) => {
        const next = 20 + Math.round(progress * 78);
        if (next >= lastProgress + 5) { lastProgress = next; updateJob(job, { progress: next }); }
      }
    });
    if (job.cancelled || !sql.getProject.get(job.project_id)) {
      await fs.unlink(output).catch(() => undefined);
      return;
    }
    updateJob(job, { output_path: output, status: "READY", progress: 100, completed_at: new Date().toISOString() });
  } catch (error) {
    if (!job.cancelled) updateJob(job, { status: "FAILED", error: friendlyVideoError(error), completed_at: new Date().toISOString() });
  } finally {
    activeJobs.delete(job.id);
    for (const file of tempFiles) await fs.unlink(file).catch(() => undefined);
  }
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    if (!job.cancelled && sql.getVideoJob.get(job.id)) await work(job);
  }
  running = false;
}

export function startVideoRenderJob(projectId) {
  const project = getProject(projectId, { includeStorage: true });
  preflight(project);
  const timestamp = new Date().toISOString();
  const job = {
    id: randomUUID(), project_id: projectId, status: "QUEUED", progress: 0,
    error: null, snapshot: JSON.stringify(project), output_path: null,
    created_at: timestamp, updated_at: timestamp, completed_at: null
  };
  sql.createVideoJob.run(job);
  queue.push(job);
  queueMicrotask(drain);
  return publicJob(job);
}

export function getVideoRenderJob(id) {
  const job = sql.getVideoJob.get(id);
  if (!job) throw new AppError("VIDEO_JOB_NOT_FOUND", "Không tìm thấy tác vụ video.", 404);
  return publicJob(job);
}

export function getVideoRenderFile(id) {
  const job = sql.getVideoJob.get(id);
  if (!job || job.status !== "READY" || !job.output_path) throw new AppError("VIDEO_JOB_NOT_READY", "Video chưa sẵn sàng.", 409);
  return job.output_path;
}

export async function deleteVideoRenderJob(id) {
  const job = sql.getVideoJob.get(id);
  if (!job) throw new AppError("VIDEO_JOB_NOT_FOUND", "Không tìm thấy video.", 404);
  const active = activeJobs.get(id);
  if (active) active.cancelled = true;
  const queued = queue.find(item => item.id === id);
  if (queued) queued.cancelled = true;
  sql.deleteVideoJob.run(id);
  if (job.output_path) await fs.unlink(job.output_path).catch(error => { if (error?.code !== "ENOENT") throw error; });
  return { deleted: true, id };
}

export async function cancelVideoRenderJobsForProject(projectId) {
  const jobs = sql.getVideoJobsByProject.all(projectId);
  for (const job of jobs) {
    const active = activeJobs.get(job.id);
    if (active) active.cancelled = true;
    const queued = queue.find(item => item.id === job.id);
    if (queued) queued.cancelled = true;
    if (job.output_path) await fs.unlink(job.output_path).catch(() => undefined);
  }
  sql.deleteVideoJobsByProject.run(projectId);
  return { deleted: jobs.length };
}

async function purgeExpiredVideos() {
  for (const job of sql.getExpiredVideoJobs.all()) await deleteVideoRenderJob(job.id).catch(() => undefined);
  await fs.mkdir(outputDir, { recursive: true });
  const known = new Set();
  for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
    const file = path.join(outputDir, entry.name);
    const job = sql.getVideoJob.get(path.basename(entry.name, ".mp4"));
    if (job) known.add(file);
    else {
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < Date.now() - 60 * 60_000) await fs.unlink(file).catch(() => undefined);
    }
  }
  return known.size;
}

const restartTime = new Date().toISOString();
sql.failInterruptedVideoJobs.run(restartTime, restartTime);
for (const row of sql.getQueuedVideoJobs.all()) queue.push({ ...row });
if (queue.length) queueMicrotask(drain);
purgeExpiredVideos().catch(() => undefined);
setInterval(() => purgeExpiredVideos().catch(() => undefined), 3600e3).unref();
