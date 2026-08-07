import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { getRenderJob } from "./render-jobs.js";
import { consumeApiQuota } from "./api-quota.js";
import { runWithQuotaPrincipal } from "./quota-principal.js";
import "./candidate-invariant.js";
import {
  createBrowserAdminSession,
  exchangeResourceAccessToken,
  getBrowserAdminSession,
  getResourceSession,
  getResourceSessionGrant
} from "./project-access.js";
import {
  isProtectedMediaPath,
  mediaResourceForPath,
  verifySignedMediaRequest
} from "./media-access.js";
import { enforceMcpPrincipal } from "./mcp-principal-binding.js";

const minuteBuckets = new Map();

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf("=");
    if (index === -1) return [part, ""];
    let value = part.slice(index + 1);
    try { value = decodeURIComponent(value); } catch { /* ignore malformed cookies */ }
    return [part.slice(0, index), value];
  }));
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function digestId(value) {
  return digest(value).toString("hex").slice(0, 20);
}

export function validApiKey(candidate) {
  if (!candidate) return false;
  const candidateDigest = digest(candidate);
  return config.apiKeys.some(key => timingSafeEqual(candidateDigest, digest(key)));
}

export function presentedApiKey(req) {
  const authorization = String(req.headers.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  return String(req.headers["x-api-key"] || bearer || "");
}

function consume(map, id, windowKey, limit, weight = 1) {
  const key = `${id}:${windowKey}`;
  const current = map.get(key) || 0;
  if (current + weight > limit) return false;
  map.set(key, current + weight);
  return true;
}

function pathname(req) {
  try { return new URL(req.originalUrl || req.url || "/", "http://localhost").pathname; }
  catch { return "/"; }
}

export function normalizedPath(req) {
  const normalized = pathname(req).toLowerCase().replace(/\/+$/u, "");
  return normalized || "/";
}

export function shouldProtect(req) {
  const path = normalizedPath(req);
  return path === "/mcp" || path.startsWith("/api/") || isProtectedMediaPath(req);
}

function decoded(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function videoAnalysisJobProjectId(jobId) {
  try {
    return db.prepare(`SELECT project_id FROM video_analysis_jobs WHERE id=?`).get(jobId)?.project_id || "";
  } catch {
    return "";
  }
}

function resourceGrantForRequest(req, session) {
  const path = normalizedPath(req);

  if (session) {
    const media = mediaResourceForPath(req);
    if (media) {
      return getResourceSessionGrant(session, media.resourceType, media.resourceId);
    }

    const carouselProject = path.match(/^\/api\/projects\/([^/]+)(?:\/|$)/u);
    if (carouselProject) {
      return getResourceSessionGrant(session, "carousel", decoded(carouselProject[1]));
    }

    const carouselVideoJob = path.match(/^\/api\/video-render-jobs\/([^/]+)(?:\/|$)/u);
    if (carouselVideoJob) {
      const projectId = sql.getVideoJob.get(decoded(carouselVideoJob[1]))?.project_id || "";
      return getResourceSessionGrant(session, "carousel", projectId);
    }

    const carouselImageJob = path.match(/^\/api\/render-jobs\/([^/]+)(?:\/|$)/u);
    if (carouselImageJob) {
      try {
        return getResourceSessionGrant(session, "carousel", getRenderJob(decoded(carouselImageJob[1])).projectId);
      } catch {
        return null;
      }
    }

    const videoProject = path.match(/^\/api\/video-analysis\/projects\/([^/]+)(?:\/|$)/u);
    if (videoProject) {
      return getResourceSessionGrant(session, "video-analysis", decoded(videoProject[1]));
    }

    const videoJob = path.match(/^\/api\/video-analysis\/jobs\/([^/]+)(?:\/|$)/u);
    if (videoJob) {
      return getResourceSessionGrant(session, "video-analysis", videoAnalysisJobProjectId(decoded(videoJob[1])));
    }
  }

  return null;
}

export function resourceSessionCanAccess(req, session) {
  return Boolean(resourceGrantForRequest(req, session));
}

function secureCookieSuffix() {
  return config.publicBaseUrl.startsWith("https:") ? "; Secure" : "";
}

function setResourceSessionCookie(res, sessionToken) {
  res.setHeader("Set-Cookie", `lana_resource_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.projectSessionTtlSeconds}${secureCookieSuffix()}`);
}

function setAdminSessionCookie(res, sessionToken) {
  res.setHeader("Set-Cookie", `lana_admin_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.projectSessionTtlSeconds}${secureCookieSuffix()}`);
}

function rateLimit(req, id, limit = config.apiRateLimitPerMinute) {
  const minute = Math.floor(Date.now() / 60_000);
  return consume(minuteBuckets, id, minute, limit);
}

function isMutation(req) {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

function isHeavyRestOperation(req) {
  const path = normalizedPath(req);
  if (/(?:assets\/import-url|video-audio|\/clone$)/u.test(path)) return true;
  if (/^\/api\/(?:video-)?render-jobs(?:\/|$)/u.test(path)) return true;
  if (/^\/api\/projects\/[^/]+\/(?:render-jobs|video-render-jobs)(?:\/|$)/u.test(path)) return true;
  if (/^\/api\/video-analysis\/projects\/[^/]+\/(?:source-reference|source-upload|render-jobs)(?:\/|$)/u.test(path)) return true;
  if (req.method === "POST" && path === "/api/video-analysis/projects") return true;
  return false;
}

function applyRestQuota(req, id) {
  if (normalizedPath(req) === "/mcp" || !isMutation(req)) return;
  consumeApiQuota(id, {
    mutations: 1,
    heavy: isHeavyRestOperation(req) ? 1 : 0
  });
}

function exchangeRateLimited(req, namespace) {
  const id = `${namespace}:${req.ip || req.socket?.remoteAddress || "unknown"}`;
  return rateLimit(req, id, 30);
}

function adminSession(req) {
  const token = parseCookies(req.headers.cookie).lana_admin_session || "";
  return getBrowserAdminSession(token);
}

function dashboardLoginUrl(req) {
  const target = normalizedPath(req) === "/" ? "/" : "/projects";
  return `/admin-auth.html?returnTo=${encodeURIComponent(target)}`;
}

function lockPrivateMediaCache(req, res) {
  if (!isProtectedMediaPath(req) || res.__lanaPrivateMediaCache) return;
  res.__lanaPrivateMediaCache = true;
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => originalSetHeader(
    name,
    String(name).toLowerCase() === "cache-control" ? "private, no-store" : value
  );
  originalSetHeader("Cache-Control", "private, no-store");
  originalSetHeader("Vary", "Cookie, Authorization, X-API-Key");
}

function authError(res, status, code, message) {
  res.setHeader("WWW-Authenticate", "Bearer");
  return res.status(status).json({ code, message });
}

export function apiSecurity(req, res, next) {
  const path = normalizedPath(req);
  const mediaRequest = isProtectedMediaPath(req);
  if (mediaRequest) lockPrivateMediaCache(req, res);

  if (req.method === "POST" && path === "/auth/admin-session") {
    if (!exchangeRateLimited(req, "admin-exchange")) {
      return res.status(429).json({ code: "RATE_LIMITED", message: "Đã thử đăng nhập quá nhiều lần." });
    }
    const key = presentedApiKey(req);
    if (!validApiKey(key)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(401).json({ code: "UNAUTHORIZED", message: "API key không hợp lệ." });
    }
    const quotaClientId = `key:${digestId(key)}`;
    const session = createBrowserAdminSession(quotaClientId);
    setAdminSessionCookie(res, session.sessionToken);
    res.setHeader("Cache-Control", "no-store");
    return res.status(204).end();
  }

  if (req.method === "GET" && path === "/auth/admin-session") {
    res.setHeader("Cache-Control", "no-store");
    return adminSession(req)
      ? res.status(204).end()
      : res.status(401).json({ code: "UNAUTHORIZED", message: "Chưa đăng nhập dashboard." });
  }

  if (req.method === "POST" && path === "/auth/resource-session") {
    if (!exchangeRateLimited(req, "resource-exchange")) {
      return res.status(429).json({ code: "RATE_LIMITED", message: "Đã thử mở link quá nhiều lần." });
    }
    try {
      const cookies = parseCookies(req.headers.cookie);
      const exchanged = exchangeResourceAccessToken(
        String(req.headers["x-resource-access-token"] || ""),
        String(req.headers["x-resource-type"] || ""),
        String(req.headers["x-resource-id"] || ""),
        cookies.lana_resource_session || cookies.lana_project_session || ""
      );
      setResourceSessionCookie(res, exchanged.sessionToken);
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    } catch (error) {
      return res.status(error?.status || 401).json({
        code: error?.code || "ACCESS_TOKEN_INVALID",
        message: error?.message || "Không thể mở dự án."
      });
    }
  }

  if (req.method === "POST" && path === "/auth/project-session") {
    if (!exchangeRateLimited(req, "project-exchange")) {
      return res.status(429).json({ code: "RATE_LIMITED", message: "Đã thử mở link quá nhiều lần." });
    }
    try {
      const cookies = parseCookies(req.headers.cookie);
      const exchanged = exchangeResourceAccessToken(
        String(req.headers["x-project-access-token"] || ""),
        "carousel",
        String(req.headers["x-project-id"] || ""),
        cookies.lana_resource_session || cookies.lana_project_session || ""
      );
      setResourceSessionCookie(res, exchanged.sessionToken);
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    } catch (error) {
      return res.status(error?.status || 401).json({
        code: error?.code || "ACCESS_TOKEN_INVALID",
        message: error?.message || "Không thể mở dự án."
      });
    }
  }

  if (
    config.apiAuthRequired &&
    ["GET", "HEAD"].includes(req.method) &&
    ["/", "/projects"].includes(path) &&
    !validApiKey(presentedApiKey(req)) &&
    !adminSession(req)
  ) {
    return res.redirect(302, dashboardLoginUrl(req));
  }

  if (!shouldProtect(req) || !config.apiAuthRequired) return next();

  if (mediaRequest && !["GET", "HEAD"].includes(req.method)) {
    return res.status(405).json({ code: "METHOD_NOT_ALLOWED", message: "Media chỉ hỗ trợ GET hoặc HEAD." });
  }

  const signedMedia = mediaRequest ? verifySignedMediaRequest(req) : null;
  if (signedMedia) {
    req.apiAccessType = "signed-media";
    req.resourceSession = { type: signedMedia.resourceType, id: signedMedia.resourceId };
    return next();
  }

  const cookies = parseCookies(req.headers.cookie);
  const key = presentedApiKey(req);
  let id;

  if (validApiKey(key)) {
    id = `key:${digestId(key)}`;
    req.apiAccessType = "api-key";
  } else {
    const admin = getBrowserAdminSession(cookies.lana_admin_session || "");
    if (admin) {
      id = admin.quota_client_id || `admin:${digestId(cookies.lana_admin_session)}`;
      req.apiAccessType = "admin-session";
    } else {
      const sessionToken = cookies.lana_resource_session || cookies.lana_project_session || "";
      const session = getResourceSession(sessionToken);
      if (!session) {
        return authError(
          res,
          401,
          "UNAUTHORIZED",
          mediaRequest ? "Thiếu phiên truy cập media hoặc phiên đã hết hạn." : "Thiếu quyền truy cập API hoặc link dự án đã hết hạn."
        );
      }
      const grant = resourceGrantForRequest(req, session);
      if (!grant) {
        return authError(
          res,
          mediaRequest ? 403 : 401,
          mediaRequest ? "MEDIA_ACCESS_DENIED" : "UNAUTHORIZED",
          mediaRequest ? "Phiên hiện tại không có quyền truy cập media này." : "Thiếu quyền truy cập API hoặc link dự án đã hết hạn."
        );
      }
      id = grant.quota_client_id || session.quota_client_id || `session:${digestId(sessionToken)}`;
      req.apiAccessType = "resource-session";
      req.resourceSession = {
        type: grant.resource_type,
        id: grant.resource_id
      };
    }
  }

  if (!rateLimit(req, id)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ code: "RATE_LIMITED", message: "Đã vượt giới hạn yêu cầu mỗi phút." });
  }

  try {
    applyRestQuota(req, id);
    if (path === "/mcp") enforceMcpPrincipal(req, res, id);
  } catch (error) {
    return res.status(error?.status || 429).json({
      code: error?.code || "DAILY_QUOTA_EXCEEDED",
      message: error?.message || "Đã vượt quota."
    });
  }

  req.apiClientId = id;
  return runWithQuotaPrincipal(id, next);
}

setInterval(() => {
  const currentMinute = Math.floor(Date.now() / 60_000);
  for (const key of minuteBuckets.keys()) {
    const bucket = Number(key.slice(key.lastIndexOf(":") + 1));
    if (Number.isFinite(bucket) && bucket < currentMinute - 2) minuteBuckets.delete(key);
  }
  const cutoff = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
  sql.purgeApiUsage.run(cutoff);
}, 15 * 60_000).unref();
