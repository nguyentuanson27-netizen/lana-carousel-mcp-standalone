import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { db, sql } from "./db.js";

const mediaTypes = new Set(["carousel", "video-analysis"]);
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const audioNamePattern = new RegExp(`^(${uuidPattern})-(${uuidPattern})\\.(?:mp3|m4a|wav)$`, "iu");

function requestUrl(value) {
  try {
    return new URL(value?.originalUrl || value?.url || value || "/", config.publicBaseUrl);
  } catch {
    return new URL("/", config.publicBaseUrl);
  }
}

function mediaMatch(value) {
  const pathname = requestUrl(value).pathname;
  for (const [prefix, kind] of [
    ["/assets/", "carousel-asset"],
    ["/video-audio/", "carousel-audio"],
    ["/video-analysis-assets/", "video-analysis-asset"]
  ]) {
    if (!pathname.toLowerCase().startsWith(prefix)) continue;
    const encoded = pathname.slice(prefix.length);
    if (!encoded || encoded.includes("/")) return null;
    let name;
    try { name = decodeURIComponent(encoded); } catch { return null; }
    if (!name || path.basename(name) !== name || name.startsWith(".")) return null;
    return { pathname, kind, name };
  }
  return null;
}

export function isProtectedMediaPath(value) {
  return Boolean(mediaMatch(value));
}

export function mediaResourceForPath(value) {
  const media = mediaMatch(value);
  if (!media) return null;

  if (media.kind === "carousel-asset") {
    const row = db.prepare(`SELECT project_id FROM assets WHERE storage_key=?`).get(media.name);
    return row?.project_id ? { resourceType: "carousel", resourceId: row.project_id } : null;
  }

  if (media.kind === "carousel-audio") {
    const projectId = audioNamePattern.exec(media.name)?.[1] || "";
    return projectId && sql.getProject.get(projectId)
      ? { resourceType: "carousel", resourceId: projectId }
      : null;
  }

  try {
    const suffix = `/video-analysis-assets/${encodeURIComponent(media.name)}`;
    const row = db.prepare(`SELECT id FROM video_analysis_projects WHERE source_url LIKE ? LIMIT 1`).get(`%${suffix}`);
    return row?.id ? { resourceType: "video-analysis", resourceId: row.id } : null;
  } catch {
    return null;
  }
}

function signingSecret() {
  return String(config.apiKeys[0] || "");
}

function signaturePayload(pathname, resourceType, resourceId, expiresAt) {
  return `${pathname}\n${resourceType}\n${resourceId}\n${expiresAt}`;
}

function sign(payload) {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function resourceExists(resourceType, resourceId) {
  if (resourceType === "carousel") return Boolean(sql.getProject.get(resourceId));
  if (resourceType !== "video-analysis") return false;
  try {
    return Boolean(db.prepare(`SELECT 1 FROM video_analysis_projects WHERE id=?`).get(resourceId));
  } catch {
    return false;
  }
}

export function createSignedMediaUrl(rawUrl, { resourceType, resourceId, ttlSeconds = 15 * 60 } = {}) {
  if (!config.apiAuthRequired) return String(rawUrl);
  if (!mediaTypes.has(resourceType) || !resourceId || !resourceExists(resourceType, resourceId)) {
    throw new Error("Cannot sign media for an unknown resource.");
  }
  const target = new URL(rawUrl, config.publicBaseUrl);
  const origin = new URL(config.publicBaseUrl);
  if (target.origin !== origin.origin || !isProtectedMediaPath(target.toString())) {
    throw new Error("Only managed same-origin media can be signed.");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(30, Math.min(3600, Number(ttlSeconds) || 900));
  target.searchParams.set("media_type", resourceType);
  target.searchParams.set("media_id", resourceId);
  target.searchParams.set("media_exp", String(expiresAt));
  target.searchParams.set("media_sig", sign(signaturePayload(target.pathname, resourceType, resourceId, expiresAt)));
  return target.toString();
}

export function verifySignedMediaRequest(req) {
  if (!config.apiAuthRequired) return null;
  const target = requestUrl(req);
  if (!isProtectedMediaPath(target.toString())) return null;
  const resourceType = target.searchParams.get("media_type") || "";
  const resourceId = target.searchParams.get("media_id") || "";
  const expiresAt = Number(target.searchParams.get("media_exp") || 0);
  const signature = target.searchParams.get("media_sig") || "";
  const now = Math.floor(Date.now() / 1000);
  if (!mediaTypes.has(resourceType) || !resourceId || !Number.isInteger(expiresAt)) return null;
  if (expiresAt < now || expiresAt > now + 3600 || !signature || !signingSecret()) return null;
  const expected = sign(signaturePayload(target.pathname, resourceType, resourceId, expiresAt));
  if (!safeEqual(signature, expected) || !resourceExists(resourceType, resourceId)) return null;
  return { resourceType, resourceId, expiresAt };
}
