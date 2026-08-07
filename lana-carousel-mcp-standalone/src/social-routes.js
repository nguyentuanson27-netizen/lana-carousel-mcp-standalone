import { z } from "zod";
import { AppError, publicError } from "./errors.js";
import { completeMetaOAuth, completeTikTokOAuth, metaOAuthUrl, tiktokOAuthUrl } from "./social-oauth.js";
import { serveSocialCarouselImage, serveSocialVideo } from "./social-media.js";
import {
  createPublishPost,
  disconnectSocialAccount,
  refreshTikTokDelivery,
  retrySocialDelivery,
  socialOverview
} from "./social-service.js";

function handle(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const safe = publicError(error);
      if (!res.headersSent) res.status(safe.status).json(safe);
    }
  };
}

function requireAdmin(req) {
  if (!["admin-session", "api-key"].includes(req.apiAccessType)) {
    throw new AppError(
      "SOCIAL_ADMIN_REQUIRED",
      "Đăng mạng xã hội chỉ khả dụng trong phiên quản trị, không khả dụng từ link dự án chia sẻ.",
      403
    );
  }
}

function callbackRedirect(projectId, result) {
  const query = new URLSearchParams({ projectId, social: "1", ...result });
  return `/widget?${query}`;
}

export function registerSocialRoutes(app) {
  app.get("/api/projects/:projectId/social/overview", handle(async (req, res) => {
    requireAdmin(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(socialOverview(req.params.projectId));
  }));

  app.get("/api/projects/:projectId/social/oauth/:provider/start", handle(async (req, res) => {
    requireAdmin(req);
    const provider = z.enum(["meta", "tiktok"]).parse(req.params.provider);
    const url = provider === "meta" ? metaOAuthUrl(req.params.projectId) : tiktokOAuthUrl(req.params.projectId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ url });
  }));

  app.post("/api/projects/:projectId/social/posts", handle(async (req, res) => {
    requireAdmin(req);
    const body = z.object({
      contentType: z.enum(["carousel", "video"]),
      caption: z.string().max(5000).default(""),
      captions: z.object({
        facebook: z.string().max(5000).optional(),
        instagram: z.string().max(2200).optional(),
        tiktok: z.string().max(2200).optional()
      }).default({}),
      accountIds: z.array(z.string().uuid()).min(1).max(20)
    }).parse(req.body || {});
    res.status(202).json(createPublishPost({ projectId: req.params.projectId, ...body }));
  }));

  app.post("/api/projects/:projectId/social/deliveries/:deliveryId/retry", handle(async (req, res) => {
    requireAdmin(req);
    res.status(202).json(retrySocialDelivery({ projectId: req.params.projectId, deliveryId: req.params.deliveryId }));
  }));

  app.post("/api/projects/:projectId/social/deliveries/:deliveryId/refresh", handle(async (req, res) => {
    requireAdmin(req);
    res.json(await refreshTikTokDelivery({ projectId: req.params.projectId, deliveryId: req.params.deliveryId }));
  }));

  app.delete("/api/projects/:projectId/social/accounts/:accountId", handle(async (req, res) => {
    requireAdmin(req);
    res.json(disconnectSocialAccount(req.params.accountId));
  }));

  app.get("/social/oauth/meta/callback", async (req, res) => {
    let projectId = "";
    try {
      if (req.query.error) throw new AppError("META_OAUTH_CANCELLED", String(req.query.error_description || req.query.error), 400);
      const result = await completeMetaOAuth({ code: String(req.query.code || ""), state: String(req.query.state || "") });
      projectId = result.projectId;
      return res.redirect(302, callbackRedirect(projectId, { socialConnected: "meta" }));
    } catch (error) {
      try {
        const stateBody = String(req.query.state || "").split(".")[0];
        projectId = JSON.parse(Buffer.from(stateBody, "base64url").toString("utf8")).projectId || "";
      } catch { /* keep empty */ }
      return res.redirect(302, callbackRedirect(projectId, { socialError: String(error?.message || "Không thể kết nối Meta.").slice(0, 300) }));
    }
  });

  app.get("/social/oauth/tiktok/callback", async (req, res) => {
    let projectId = "";
    try {
      if (req.query.error) throw new AppError("TIKTOK_OAUTH_CANCELLED", String(req.query.error_description || req.query.error), 400);
      const result = await completeTikTokOAuth({ code: String(req.query.code || ""), state: String(req.query.state || "") });
      projectId = result.projectId;
      return res.redirect(302, callbackRedirect(projectId, { socialConnected: "tiktok" }));
    } catch (error) {
      try {
        const stateBody = String(req.query.state || "").split(".")[0];
        projectId = JSON.parse(Buffer.from(stateBody, "base64url").toString("utf8")).projectId || "";
      } catch { /* keep empty */ }
      return res.redirect(302, callbackRedirect(projectId, { socialError: String(error?.message || "Không thể kết nối TikTok.").slice(0, 300) }));
    }
  });

  app.get("/social-media/carousel/:projectId/:slideId.webp", handle(serveSocialCarouselImage));
  app.get("/social-media/video/:projectId/:jobId.mp4", handle(async (req, res) => serveSocialVideo(req, res)));
}
