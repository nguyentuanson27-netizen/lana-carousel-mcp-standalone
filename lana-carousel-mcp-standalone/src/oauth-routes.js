import { createHash } from "node:crypto";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { createBrowserAdminSession, getBrowserAdminSession } from "./project-access.js";
import {
  consumeConsentRequest,
  consumeGoogleLoginState,
  createConsentRequest,
  createGoogleLoginState,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  isRegisteredOAuthClient,
  issueAuthorizationCode,
  mcpResourceUri,
  registerOAuthClient,
  validateAuthorizationRequest
} from "./oauth-store.js";

const registrationBuckets = new Map();
const tokenBuckets = new Map();
const tokenPreAuthBuckets = new Map();
const OAUTH_TOKEN_REQUESTS_PER_MINUTE = 60;
const OAUTH_TOKEN_PREAUTH_REQUESTS_PER_MINUTE = OAUTH_TOKEN_REQUESTS_PER_MINUTE * 10;
const jsonParser = express.json({ limit: "64kb", type: ["application/json", "application/*+json"] });
const formParser = express.urlencoded({ extended: false, limit: "64kb" });

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf("=");
    if (index === -1) return [part, ""];
    let value = part.slice(index + 1);
    try { value = decodeURIComponent(value); } catch { /* ignore malformed cookie */ }
    return [part.slice(0, index), value];
  }));
}

function secureCookieSuffix() {
  return config.publicBaseUrl.startsWith("https:") ? "; Secure" : "";
}

function setAdminSessionCookie(res, sessionToken) {
  res.setHeader("Set-Cookie", `lana_admin_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.projectSessionTtlSeconds}${secureCookieSuffix()}`);
}

function currentAdmin(req) {
  const token = parseCookies(req.headers.cookie).lana_admin_session || "";
  return getBrowserAdminSession(token);
}

function safeReturnTo(candidate, fallback = "/projects") {
  const raw = String(candidate || "");
  const allowed = new Set(["/", "/projects", "/widget", "/oauth/authorize"]);
  if (!raw || raw.includes("\\") || /%5c/iu.test(raw) || /^[\\/]{2}/u.test(raw)) return fallback;
  try {
    const origin = new URL(config.publicBaseUrl);
    const target = new URL(raw, origin);
    if (target.origin !== origin.origin || !allowed.has(target.pathname)) return fallback;
    return `${target.pathname}${target.search}`;
  } catch {
    return fallback;
  }
}

function googleClient() {
  return new OAuth2Client(
    config.googleOAuthClientId,
    config.googleOAuthClientSecret,
    `${config.publicBaseUrl}/auth/google/callback`
  );
}

function oauthProtocolError(res, error) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(error?.status || 400).json({
    error: error?.code || "invalid_request",
    error_description: error?.message || "OAuth request không hợp lệ."
  });
}

export function setOAuthHtmlSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/gu, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[character]);
}

function redirectWithParams(res, redirectUri, values) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value) target.searchParams.set(key, value);
  return res.redirect(302, target.toString());
}

function registrationAllowed(req) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const id = `${req.ip || req.socket?.remoteAddress || "unknown"}:${hour}`;
  const count = registrationBuckets.get(id) || 0;
  if (count >= 30) return false;
  registrationBuckets.set(id, count + 1);
  for (const key of registrationBuckets.keys()) {
    const bucket = Number(key.slice(key.lastIndexOf(":") + 1));
    if (Number.isFinite(bucket) && bucket < hour - 2) registrationBuckets.delete(key);
  }
  return true;
}

function consumeMinuteBucket(buckets, principal, limit, nowMs = Date.now()) {
  const timestamp = Number(nowMs);
  const minute = Math.floor(timestamp / 60_000);
  const id = `${principal}:${minute}`;
  const count = buckets.get(id) || 0;
  if (count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((((minute + 1) * 60_000) - timestamp) / 1000))
    };
  }
  buckets.set(id, count + 1);
  for (const key of buckets.keys()) {
    const bucket = Number(key.slice(key.lastIndexOf(":") + 1));
    if (Number.isFinite(bucket) && bucket < minute - 2) buckets.delete(key);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function tokenRateLimitPrincipal(rawClientId) {
  const clientId = String(rawClientId || "").trim();
  if (!/^client_[A-Za-z0-9_-]{43,64}$/u.test(clientId)) return "unknown-client";
  return isRegisteredOAuthClient(clientId) ? clientId : "unknown-client";
}

export function consumeOAuthTokenRateLimit(clientId, nowMs = Date.now()) {
  return consumeMinuteBucket(
    tokenBuckets,
    tokenRateLimitPrincipal(clientId),
    OAUTH_TOKEN_REQUESTS_PER_MINUTE,
    nowMs
  );
}

export function consumeOAuthTokenPreAuthRateLimit(source, nowMs = Date.now()) {
  const principal = String(source || "unknown-source").slice(0, 128);
  return consumeMinuteBucket(
    tokenPreAuthBuckets,
    principal,
    OAUTH_TOKEN_PREAUTH_REQUESTS_PER_MINUTE,
    nowMs
  );
}

function enforceProvenClientTokenRateLimit(clientId) {
  const rateLimit = consumeOAuthTokenRateLimit(clientId);
  if (rateLimit.allowed) return;
  const error = new AppError("rate_limited", "Đã gửi quá nhiều yêu cầu OAuth token hợp lệ cho client này.", 429);
  error.retryAfterSeconds = rateLimit.retryAfterSeconds;
  throw error;
}

export function oauthProtectedResourceMetadata() {
  return {
    resource: mcpResourceUri(),
    authorization_servers: [config.publicBaseUrl],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"]
  };
}

export function oauthAuthorizationServerMetadata() {
  return {
    issuer: config.publicBaseUrl,
    authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${config.publicBaseUrl}/oauth/token`,
    registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"]
  };
}

export function assertAllowedGoogleIdentity(payload = {}) {
  const email = String(payload.email || "").trim().toLowerCase();
  const subject = String(payload.sub || "").trim();
  if (!subject || !email || payload.email_verified !== true) {
    throw new AppError("GOOGLE_IDENTITY_INVALID", "Tài khoản Google chưa xác minh email.", 403);
  }
  const domain = email.split("@").at(-1) || "";
  const allowed = config.oauthAllowedEmails.includes(email) || config.oauthAllowedDomains.includes(domain);
  if ((config.oauthAllowedEmails.length || config.oauthAllowedDomains.length) && !allowed) {
    throw new AppError("GOOGLE_ACCOUNT_NOT_ALLOWED", "Tài khoản Google này không có quyền truy cập Lana Content Studio.", 403);
  }
  return { email, subject, name: String(payload.name || email).slice(0, 200) };
}

function principalForGoogleSubject(subject) {
  return `user:${createHash("sha256").update(String(subject)).digest("hex").slice(0, 32)}`;
}

function pageShell(title, body) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f5f1eb;color:#2b221d;font:15px/1.5 system-ui,sans-serif}main{width:min(520px,100%);padding:30px;border:1px solid #ded4ca;border-radius:24px;background:#fffdf9;box-shadow:0 24px 80px #39261b1f}h1{margin:0 0 8px;font:500 31px Georgia,serif}p{color:#796d64}.client{padding:14px 16px;border:1px solid #ded4ca;border-radius:14px;background:#faf6f1;margin:18px 0}.warning{padding:12px 14px;border:1px solid #d8a948;border-radius:12px;background:#fff8df;color:#6e5415;font-weight:650}.redirect{display:block;margin-top:8px;padding:10px 12px;border-radius:10px;background:#fff;color:#493f38;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.actions{display:flex;gap:10px;margin-top:22px}.actions button,.actions a{flex:1;padding:12px;border-radius:999px;border:1px solid #8d3f3d;font:700 14px system-ui;cursor:pointer;text-align:center;text-decoration:none}.approve{background:#8d3f3d;color:#fff}.deny{background:#fff;color:#8d3f3d}</style></head><body><main>${body}</main></body></html>`;
}

function oauthSameSiteBridgeHtml(returnTo) {
  const destination = safeReturnTo(returnTo, "/projects");
  const escapedDestination = escapeHtml(destination);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escapedDestination}"><title>Tiếp tục kết nối Lana MCP</title></head><body><p>Đang tiếp tục kết nối Lana MCP…</p><a rel="noreferrer" href="${escapedDestination}">Tiếp tục</a></body></html>`;
}

function needsOAuthSameSiteBridge(returnTo) {
  const destination = safeReturnTo(returnTo, "/projects");
  return destination === "/oauth/authorize" || destination.startsWith("/oauth/authorize?");
}

export function consentHtml({ clientName, scope, consentToken, redirectUri }) {
  let redirectHost = "không xác định";
  try { redirectHost = new URL(redirectUri).host; } catch { /* validated upstream */ }
  return pageShell("Cấp quyền Lana MCP", `<h1>Kết nối Lana MCP</h1><p>Một ứng dụng muốn truy cập Lana MCP bằng tài khoản Google bạn vừa xác thực.</p><div class="warning">Client này được đăng ký động và <strong>chưa được Lana xác minh</strong>. Tên ứng dụng bên dưới do chính client tự khai báo; hãy kiểm tra kỹ nơi nhận callback trước khi cho phép.</div><div class="client"><strong>${escapeHtml(clientName)}</strong><br><span>Quyền: ${escapeHtml(scope)}</span><br><span>Callback host: <strong>${escapeHtml(redirectHost)}</strong></span><code class="redirect">${escapeHtml(redirectUri)}</code></div><p>Chỉ chọn “Cho phép” nếu bạn nhận ra callback host ở trên và tin tưởng ứng dụng này.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="consent_token" value="${escapeHtml(consentToken)}"><div class="actions"><button class="deny" type="submit" name="decision" value="deny">Hủy</button><button class="approve" type="submit" name="decision" value="approve">Cho phép</button></div></form>`);
}

function expiredConsentHtml() {
  return pageShell("Phiên cấp quyền đã hết hạn", `<h1>Phiên xác thực đã hết hạn</h1><p>Phiên đăng nhập Lana đã hết hạn trong lúc bạn đang cấp quyền MCP. Vì authorization request gốc không được phục hồi từ một POST đã hết phiên, Lana dừng flow tại đây thay vì redirect thiếu tham số.</p><p>Hãy quay lại ChatGPT hoặc MCP client và chọn kết nối lại để bắt đầu một OAuth flow mới.</p><div class="actions"><a class="approve" href="/admin-auth.html">Đăng nhập Lana</a></div>`);
}

export function registerOAuthRoutes(app) {
  if (config.oauthTrustedProxyCidrs.length > 0) {
    app.set("trust proxy", config.oauthTrustedProxyCidrs);
  }

  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(oauthProtectedResourceMetadata());
  });

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(oauthAuthorizationServerMetadata());
  });

  app.post("/oauth/register", jsonParser, (req, res) => {
    if (!registrationAllowed(req)) {
      res.setHeader("Retry-After", "3600");
      return oauthProtocolError(res, new AppError("rate_limited", "Đã đăng ký quá nhiều OAuth client từ địa chỉ này.", 429));
    }
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json(registerOAuthClient(req.body || {}));
    } catch (error) {
      return oauthProtocolError(res, error);
    }
  });

  app.get("/auth/google/start", (req, res) => {
    if (!config.googleOAuthConfigured) return res.status(503).json({ code: "GOOGLE_OAUTH_NOT_CONFIGURED", message: "Google OAuth chưa được cấu hình." });
    const returnTo = safeReturnTo(req.query.returnTo);
    const state = createGoogleLoginState(returnTo);
    const url = googleClient().generateAuthUrl({
      access_type: "online",
      prompt: "select_account",
      scope: ["openid", "email", "profile"],
      state
    });
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, url);
  });

  app.get("/auth/google/callback", async (req, res) => {
    let returnTo = "/projects";
    try {
      returnTo = consumeGoogleLoginState(String(req.query.state || ""));
      if (req.query.error) throw new AppError("GOOGLE_OAUTH_DENIED", "Đăng nhập Google đã bị hủy.", 401);
      const code = String(req.query.code || "");
      if (!code) throw new AppError("GOOGLE_OAUTH_CODE_REQUIRED", "Google không trả authorization code.", 400);
      const client = googleClient();
      const { tokens } = await client.getToken(code);
      if (!tokens.id_token) throw new AppError("GOOGLE_ID_TOKEN_REQUIRED", "Google không trả ID token.", 401);
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.googleOAuthClientId });
      const identity = assertAllowedGoogleIdentity(ticket.getPayload() || {});
      const session = createBrowserAdminSession(principalForGoogleSubject(identity.subject));
      setAdminSessionCookie(res, session.sessionToken);
      if (needsOAuthSameSiteBridge(returnTo)) {
        setOAuthHtmlSecurityHeaders(res);
        res.setHeader("Referrer-Policy", "no-referrer");
        return res.status(200).send(oauthSameSiteBridgeHtml(returnTo));
      }
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, returnTo);
    } catch (error) {
      const target = new URL("/admin-auth.html", config.publicBaseUrl);
      target.searchParams.set("returnTo", safeReturnTo(returnTo));
      target.searchParams.set("authError", error?.message || "Không thể đăng nhập Google.");
      return res.redirect(302, `${target.pathname}${target.search}`);
    }
  });

  app.get("/oauth/authorize", (req, res) => {
    let request;
    try {
      request = validateAuthorizationRequest(req.query || {});
    } catch (error) {
      return oauthProtocolError(res, error);
    }
    const admin = currentAdmin(req);
    if (!admin) {
      const returnTo = safeReturnTo(req.originalUrl || req.url, "/projects");
      return res.redirect(302, `/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const consentToken = createConsentRequest(request, admin.quota_client_id);
    setOAuthHtmlSecurityHeaders(res);
    return res.status(200).send(consentHtml({ clientName: request.clientName, scope: request.scope, consentToken, redirectUri: request.redirectUri }));
  });

  app.post("/oauth/authorize", formParser, (req, res) => {
    const admin = currentAdmin(req);
    if (!admin) {
      setOAuthHtmlSecurityHeaders(res);
      return res.status(401).send(expiredConsentHtml());
    }
    try {
      const consent = consumeConsentRequest(String(req.body.consent_token || ""), admin.quota_client_id);
      if (req.body.decision !== "approve") {
        return redirectWithParams(res, consent.redirect_uri, { error: "access_denied", state: consent.oauth_state });
      }
      const code = issueAuthorizationCode(consent);
      return redirectWithParams(res, consent.redirect_uri, { code, state: consent.oauth_state });
    } catch (error) {
      return oauthProtocolError(res, error);
    }
  });

  app.post("/oauth/token", formParser, (req, res, next) => {
    const rateLimit = consumeOAuthTokenPreAuthRateLimit(req.ip || req.socket?.remoteAddress || "unknown-source");
    if (rateLimit.allowed) return next();
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    return oauthProtocolError(res, new AppError("rate_limited", "Đã gửi quá nhiều yêu cầu tới OAuth token endpoint từ nguồn kết nối này.", 429));
  }, (req, res) => {
    try {
      const grantType = String(req.body.grant_type || "");
      let tokens;
      if (grantType === "authorization_code") {
        tokens = exchangeAuthorizationCode({
          code: req.body.code,
          clientId: req.body.client_id,
          redirectUri: req.body.redirect_uri,
          codeVerifier: req.body.code_verifier,
          resource: req.body.resource,
          beforeExchange: enforceProvenClientTokenRateLimit
        });
      } else if (grantType === "refresh_token") {
        tokens = exchangeRefreshToken({
          refreshToken: req.body.refresh_token,
          clientId: req.body.client_id,
          resource: req.body.resource,
          beforeExchange: enforceProvenClientTokenRateLimit
        });
      } else {
        throw new AppError("unsupported_grant_type", "Chỉ hỗ trợ authorization_code và refresh_token.", 400);
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json(tokens);
    } catch (error) {
      if (Number.isFinite(Number(error?.retryAfterSeconds))) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      return oauthProtocolError(res, error);
    }
  });
}
