import { randomUUID } from "node:crypto";
import archiver from "archiver";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { getApprovedAssetFiles } from "./service.js";

const jobs = new Map();

async function zipFiles(files) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("data", chunk => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const file of files) archive.append(file.buffer, { name: file.name });
    archive.finalize();
  });
}

export function startRenderJob(projectId) {
  const id = randomUUID();
  const job = { id, projectId, status: "QUEUED", progress: 0, createdAt: new Date().toISOString(), buffer: null, error: null };
  jobs.set(id, job);
  queueMicrotask(async () => {
    try {
      job.status = "RENDERING"; job.progress = 10;
      const files = await getApprovedAssetFiles(projectId);
      job.progress = 75;
      job.buffer = await zipFiles(files);
      job.status = "READY"; job.progress = 100; job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = "FAILED"; job.error = error?.message || "Render failed"; job.completedAt = new Date().toISOString();
    }
  });
  return publicJob(job);
}

function publicJob(job) {
  return {
    id: job.id, projectId: job.projectId, status: job.status, progress: job.progress,
    error: job.error, createdAt: job.createdAt, completedAt: job.completedAt,
    downloadUrl: job.status === "READY" ? `${config.publicBaseUrl}/api/render-jobs/${job.id}/download` : null
  };
}

export function getRenderJob(id) {
  const job = jobs.get(id);
  if (!job) throw new AppError("RENDER_JOB_NOT_FOUND", "Không tìm thấy tác vụ render.", 404);
  return publicJob(job);
}

export function getRenderJobBuffer(id) {
  const job = jobs.get(id);
  if (!job) throw new AppError("RENDER_JOB_NOT_FOUND", "Không tìm thấy tác vụ render.", 404);
  if (job.status !== "READY") throw new AppError("RENDER_JOB_NOT_READY", "Ảnh chưa render xong.", 409);
  return { buffer: job.buffer, projectId: job.projectId };
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
}, 15 * 60 * 1000).unref();
