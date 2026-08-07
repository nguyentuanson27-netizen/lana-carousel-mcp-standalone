import { config } from "./config.js";

function integerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function text(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

export const socialConfig = Object.freeze({
  tokenEncryptionKey: text("SOCIAL_TOKEN_ENCRYPTION_KEY"),
  oauthStateSecret: text("SOCIAL_OAUTH_STATE_SECRET") || text("SOCIAL_TOKEN_ENCRYPTION_KEY"),
  mediaSigningSecret: text("SOCIAL_MEDIA_SIGNING_SECRET") || text("SOCIAL_OAUTH_STATE_SECRET") || text("SOCIAL_TOKEN_ENCRYPTION_KEY"),
  mediaUrlTtlSeconds: integerEnv("SOCIAL_MEDIA_URL_TTL_SECONDS", 6 * 60 * 60),
  requestTimeoutMs: integerEnv("SOCIAL_REQUEST_TIMEOUT_MS", 30_000),
  instagramProcessingTimeoutMs: integerEnv("SOCIAL_INSTAGRAM_PROCESSING_TIMEOUT_MS", 120_000),
  metaGraphVersion: text("META_GRAPH_API_VERSION", "v23.0"),
  metaAppId: text("META_APP_ID"),
  metaAppSecret: text("META_APP_SECRET"),
  tiktokClientKey: text("TIKTOK_CLIENT_KEY"),
  tiktokClientSecret: text("TIKTOK_CLIENT_SECRET"),
  metaRedirectUri: `${config.publicBaseUrl}/social/oauth/meta/callback`,
  tiktokRedirectUri: `${config.publicBaseUrl}/social/oauth/tiktok/callback`,
  publicBaseUrl: config.publicBaseUrl
});

export function socialFeatureStatus() {
  const encryptionReady = Boolean(socialConfig.tokenEncryptionKey && socialConfig.mediaSigningSecret && socialConfig.oauthStateSecret);
  return {
    encryptionReady,
    metaOAuthReady: encryptionReady && Boolean(socialConfig.metaAppId && socialConfig.metaAppSecret),
    tiktokOAuthReady: encryptionReady && Boolean(socialConfig.tiktokClientKey && socialConfig.tiktokClientSecret)
  };
}
