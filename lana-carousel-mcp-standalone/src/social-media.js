import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { AppError } from "./errors.js";
import { socialConfig } from "./social-config.js";
import { signMediaPath, verifyMediaSignature } from "./social-crypto.js";
import { getProject, renderSlideSnapshot } from "./service-core.js";
import { getSocialPost } from "./social-store.js";
import { getVideoRenderFile, getVideoRenderJob } from "./video-jobs.js";

export const socialMediaSnapshotDirectory = path.join(path.dirname(config.databasePath), "social-media");

function signedUrl(pathname) {
  const expires = Math.floor(Date.now() / 1000) + socialConfig.mediaUrlTtlSeconds;
  const signature = signMediaPath(pathname, expires);
  return `${socialConfig.publicBaseUrl}${pathname}?expires=${expires}&sig=${encodeURIComponent(signature)}`;
}

function snapshotDirectory(snapshotId) {
  const id = String(snapshotId || "");
  if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new AppError("SOCIAL_MEDIA_SNAPSHOT_INVALID", "Media snapshot không hợp lệ.", 500);
  return path.join(socialMediaSnapshotDirectory, id);
}

function snapshotFile(snapshotId, fileName) {
  const name = String(fileName || "");
  if (!name || path.basename(name) !== name) throw new AppError("SOCIAL_MEDIA_FILE_INVALID", "Tên media snapshot không hợp lệ.", 400);
  return path.join(snapshotDirectory(snapshotId), name);
}

function validateCarouselProject(project) {
  if (project.contentStatus !== "APPROVED" || project.imageStatus !== "APPROVED") {
    throw new AppError("SOCIAL_CAROUSEL_NOT_APPROVED", "Cần duyệt nội dung và ảnh trước khi đăng Carousel.", 409);
  }
  if (!project.slides.length || !project.slides.every(slide => slide.imageApproved && slide.selectedAssetId && slide.designSaved)) {
    throw new AppError("SOCIAL_CAROUSEL_NOT_READY", "Mọi slide cần có ảnh duyệt và đã Lưu thiết kế trước khi đăng.", 409);
  }
}

export function latestReadyVideoJob(projectId) {
  const row = sql.getVideoJobsByProject.all(projectId).find(job => job.status === "READY" && job.output_path);
  if (!row) return null;
  return getVideoRenderJob(row.id);
}

export function socialCarouselMedia(projectId) {
  const project = getProject(projectId);
  validateCarouselProject(project);
  return project.slides.slice(0, 10).map(slide => ({ slideId: slide.id, position: slide.position }));
}

export function socialVideoMedia(projectId) {
  const job = latestReadyVideoJob(projectId);
  if (!job) throw new AppError("SOCIAL_VIDEO_NOT_READY", "Chưa có MP4 READY. Hãy render video trước khi đăng.", 409);
  return { jobId: job.id };
}

export async function createSocialMediaSnapshot(projectId, contentType) {
  const snapshotId = randomUUID();
  const directory = snapshotDirectory(snapshotId);
  await fs.mkdir(directory, { recursive: true });
  try {
    if (contentType === "carousel") {
      const project = getProject(projectId, { includeStorage: true });
      validateCarouselProject(project);
      const items = [];
      for (const [index, slide] of project.slides.slice(0, 10).entries()) {
        const fileName = `${String(index + 1).padStart(2, "0")}.jpg`;
        const rendered = await renderSlideSnapshot(slide, project.assets);
        const jpeg = await sharp(rendered).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
        await fs.writeFile(snapshotFile(snapshotId, fileName), jpeg, { flag: "wx" });
        items.push({ fileName, slideId: slide.id, position: slide.position });
      }
      return {
        version: 1,
        type: "carousel",
        snapshotId,
        projectId,
        projectTitle: project.title,
        items,
        createdAt: new Date().toISOString()
      };
    }

    if (contentType === "video") {
      const project = getProject(projectId);
      const video = socialVideoMedia(projectId);
      const fileName = "video.mp4";
      await fs.copyFile(getVideoRenderFile(video.jobId), snapshotFile(snapshotId, fileName));
      return {
        version: 1,
        type: "video",
        snapshotId,
        projectId,
        projectTitle: project.title,
        jobId: video.jobId,
        fileName,
        createdAt: new Date().toISOString()
      };
    }

    throw new AppError("SOCIAL_CONTENT_TYPE_INVALID", "Loại nội dung Social không hợp lệ.", 400);
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function socialMediaFromSnapshot(post) {
  const snapshot = post?.mediaSnapshot || {};
  if (!snapshot.snapshotId || snapshot.type !== post?.contentType) {
    throw new AppError("SOCIAL_MEDIA_SNAPSHOT_MISSING", "Lượt đăng không có media snapshot hợp lệ.", 409);
  }
  if (snapshot.type === "carousel") {
    if (!Array.isArray(snapshot.items) || !snapshot.items.length) {
      throw new AppError("SOCIAL_MEDIA_SNAPSHOT_MISSING", "Media snapshot Carousel rỗng.", 409);
    }
    return {
      video: null,
      images: snapshot.items.map(item => ({
        slideId: item.slideId,
        position: item.position,
        url: signedUrl(`/social-media/posts/${encodeURIComponent(post.id)}/${encodeURIComponent(item.fileName)}`)
      }))
    };
  }
  if (!snapshot.fileName) throw new AppError("SOCIAL_MEDIA_SNAPSHOT_MISSING", "Media snapshot Video rỗng.", 409);
  return {
    images: [],
    video: {
      jobId: snapshot.jobId || null,
      url: signedUrl(`/social-media/posts/${encodeURIComponent(post.id)}/${encodeURIComponent(snapshot.fileName)}`)
    }
  };
}

export async function removeSocialMediaSnapshot(snapshot) {
  if (!snapshot?.snapshotId) return;
  await fs.rm(snapshotDirectory(snapshot.snapshotId), { recursive: true, force: true }).catch(() => undefined);
}

export async function purgeOrphanedSocialMediaSnapshots() {
  await fs.mkdir(socialMediaSnapshotDirectory, { recursive: true });
  const referenced = new Set();
  for (const row of db.prepare(`SELECT media_snapshot FROM social_posts`).all()) {
    try {
      const snapshot = JSON.parse(row.media_snapshot || "{}");
      if (snapshot?.snapshotId) referenced.add(snapshot.snapshotId);
    } catch { /* ignore malformed legacy row */ }
  }
  const entries = await fs.readdir(socialMediaSnapshotDirectory, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || referenced.has(entry.name)) continue;
    await fs.rm(path.join(socialMediaSnapshotDirectory, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function validRequest(req) {
  return verifyMediaSignature(req.path, req.query.expires, req.query.sig);
}

export function serveSocialSnapshotFile(req, res) {
  if (!validRequest(req)) return res.status(403).send("Expired or invalid social media URL");
  const post = getSocialPost(req.params.postId);
  if (!post) return res.status(404).send("Social post not available");
  const snapshot = post.mediaSnapshot || {};
  const fileName = String(req.params.fileName || "");
  const allowed = snapshot.type === "carousel"
    ? (snapshot.items || []).some(item => item.fileName === fileName)
    : snapshot.type === "video" && snapshot.fileName === fileName;
  if (!allowed) return res.status(404).send("Social media file not available");
  const absolutePath = snapshotFile(snapshot.snapshotId, fileName);
  res.setHeader("Content-Type", fileName.endsWith(".mp4") ? "video/mp4" : "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.sendFile(path.resolve(absolutePath));
}
