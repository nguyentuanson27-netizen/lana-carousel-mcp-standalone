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

const metaGraphVersion = text("META_GRAPH_API_VERSION", "v23.0");

export const socialConfig = Object.freeze({
  tokenEncryptionKey: text("SOCIAL_TOKEN_ENCRYPTION_KEY"),
  oauthStateSecret: text("SOCIAL_OAUTH_STATE_SECRET") || text("SOCIAL_TOKEN_ENCRYPTION_KEY"),
  mediaSigningSecret: text("SOCIAL_MEDIA_SIGNING_SECRET") || text("SOCIAL_OAUTH_STATE_SECRET") || text("SOCIAL_TOKEN_ENCRYPTION_KEY"),
  mediaUrlTtlSeconds: integerEnv("SOCIAL_MEDIA_URL_TTL_SECONDS", 6 * 60 * 60),
  requestTimeoutMs: integerEnv("SOCIAL_REQUEST_TIMEOUT_MS", 30_000),
  instagramProcessingTimeoutMs: integerEnv("SOCIAL_INSTAGRAM_PROCESSING_TIMEOUT_MS", 120_000),
  metaGraphVersion,
  facebookPageId: text("FACEBOOK_PAGE_ID"),
  facebookPageName: text("FACEBOOK_PAGE_NAME", "Facebook Page"),
  facebookPageAccessToken: text("FACEBOOK_PAGE_ACCESS_TOKEN"),
  instagramGraphVersion: text("INSTAGRAM_GRAPH_API_VERSION", metaGraphVersion),
  instagramAppId: text("INSTAGRAM_APP_ID"),
  instagramAppSecret: text("INSTAGRAM_APP_SECRET"),
  tiktokClientKey: text("TIKTOK_CLIENT_KEY"),
  tiktokClientSecret: text("TIKTOK_CLIENT_SECRET"),
  instagramRedirectUri: `${config.publicBaseUrl}/social/oauth/instagram/callback`,
  tiktokRedirectUri: `${config.publicBaseUrl}/social/oauth/tiktok/callback`,
  publicBaseUrl: config.publicBaseUrl
});

export function socialFeatureStatus() {
  const encryptionReady = Boolean(socialConfig.tokenEncryptionKey && socialConfig.mediaSigningSecret && socialConfig.oauthStateSecret);
  return {
    encryptionReady,
    facebookPageReady: encryptionReady && Boolean(socialConfig.facebookPageId && socialConfig.facebookPageAccessToken),
    instagramOAuthReady: encryptionReady && Boolean(socialConfig.instagramAppId && socialConfig.instagramAppSecret),
    tiktokOAuthReady: encryptionReady && Boolean(socialConfig.tiktokClientKey && socialConfig.tiktokClientSecret)
  };
}
