import path from "node:path";
import { AppError } from "./errors.js";
import { socialConfig } from "./social-config.js";
import { signMediaPath, verifyMediaSignature } from "./social-crypto.js";
import { getProject, renderSlideSnapshot } from "./service-core.js";
import { getVideoRenderFile, getVideoRenderJob } from "./video-jobs.js";
import { sql } from "./db.js";

function signedUrl(pathname) {
  const expires = Math.floor(Date.now() / 1000) + socialConfig.mediaUrlTtlSeconds;
  const signature = signMediaPath(pathname, expires);
  return `${socialConfig.publicBaseUrl}${pathname}?expires=${expires}&sig=${encodeURIComponent(signature)}`;
}

export function latestReadyVideoJob(projectId) {
  const row = sql.getVideoJobsByProject.all(projectId).find(job => job.status === "READY" && job.output_path);
  if (!row) return null;
  return getVideoRenderJob(row.id);
}

export function socialCarouselMedia(projectId) {
  const project = getProject(projectId);
  if (project.contentStatus !== "APPROVED" || project.imageStatus !== "APPROVED") {
    throw new AppError("SOCIAL_CAROUSEL_NOT_APPROVED", "Cần duyệt nội dung và ảnh trước khi đăng Carousel.", 409);
  }
  if (!project.slides.length || !project.slides.every(slide => slide.imageApproved && slide.selectedAssetId && slide.designSaved)) {
    throw new AppError("SOCIAL_CAROUSEL_NOT_READY", "Mọi slide cần có ảnh duyệt và đã Lưu thiết kế trước khi đăng.", 409);
  }
  return project.slides.slice(0, 10).map(slide => ({
    slideId: slide.id,
    position: slide.position,
    url: signedUrl(`/social-media/carousel/${encodeURIComponent(projectId)}/${encodeURIComponent(slide.id)}.webp`)
  }));
}

export function socialVideoMedia(projectId) {
  const job = latestReadyVideoJob(projectId);
  if (!job) throw new AppError("SOCIAL_VIDEO_NOT_READY", "Chưa có MP4 READY. Hãy render video trước khi đăng.", 409);
  return {
    jobId: job.id,
    url: signedUrl(`/social-media/video/${encodeURIComponent(projectId)}/${encodeURIComponent(job.id)}.mp4`)
  };
}

function validRequest(req) {
  return verifyMediaSignature(req.path, req.query.expires, req.query.sig);
}

export async function serveSocialCarouselImage(req, res) {
  if (!validRequest(req)) return res.status(403).send("Expired or invalid social media URL");
  const project = getProject(req.params.projectId, { includeStorage: true });
  const slide = project.slides.find(item => item.id === req.params.slideId);
  if (!slide || !slide.imageApproved || !slide.designSaved) return res.status(404).send("Slide not available");
  const buffer = await renderSlideSnapshot(slide, project.assets);
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(buffer);
}

export function serveSocialVideo(req, res) {
  if (!validRequest(req)) return res.status(403).send("Expired or invalid social media URL");
  const job = getVideoRenderJob(req.params.jobId);
  if (job.projectId !== req.params.projectId || job.status !== "READY") return res.status(404).send("Video not available");
  const file = getVideoRenderFile(req.params.jobId);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.sendFile(path.resolve(file));
}
