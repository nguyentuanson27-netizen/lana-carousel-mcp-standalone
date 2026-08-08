import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function integerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function resolveFromRoot(value, fallback) {
  return path.resolve(projectRoot, value || fallback);
}

function csvEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

export function validateApiKeys(values, { required = false } = {}) {
  const keys = [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))];
  if (required && keys.length === 0) throw new Error("API_KEY or API_KEYS is required");
  const placeholder = /^(?:replace|change|changeme|example|sample|test|dev|your)[-_ ]/iu;
  for (const key of keys) {
    if (key.length < 32) throw new Error("Every API key must contain at least 32 characters");
    if (placeholder.test(key) || /long-random-secret|api-key-here/iu.test(key)) throw new Error("Refusing placeholder API key; generate a real random secret");
  }
  return keys;
}

const production = process.env.NODE_ENV === "production";
const apiKeys = validateApiKeys([...csvEnv("API_KEYS"), ...csvEnv("API_KEY")]);
const googleOAuthClientId = String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
const googleOAuthClientSecret = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
const googleOAuthConfigured = Boolean(googleOAuthClientId && googleOAuthClientSecret);
const oauthAllowedEmails = csvEnv("OAUTH_ALLOWED_EMAILS").map(value => value.toLowerCase());
const oauthAllowedDomains = csvEnv("OAUTH_ALLOWED_DOMAINS").map(value => value.toLowerCase().replace(/^@/u, ""));

if (Boolean(googleOAuthClientId) !== Boolean(googleOAuthClientSecret)) {
  throw new Error("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be configured together");
}
if (production && !googleOAuthConfigured) {
  throw new Error("Google OAuth is required in production: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET");
}
if (production && oauthAllowedEmails.length === 0 && oauthAllowedDomains.length === 0) {
  throw new Error("Set OAUTH_ALLOWED_EMAILS or OAUTH_ALLOWED_DOMAINS in production");
}

export const config = Object.freeze({
  port: integerEnv("PORT", 8787),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/$/, ""),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH, "./data/lana-carousel.sqlite"),
  assetDirectory: resolveFromRoot(process.env.ASSET_DIRECTORY, "./data/assets"),
  maxImageBytes: integerEnv("MAX_IMAGE_BYTES", 10 * 1024 * 1024),
  imageTimeoutMs: integerEnv("IMAGE_TIMEOUT_MS", 15_000),
  maxRemoteVideoBytes: integerEnv("MAX_REMOTE_VIDEO_BYTES", 500 * 1024 * 1024),
  videoSourceTimeoutMs: integerEnv("VIDEO_SOURCE_TIMEOUT_MS", 120_000),
  maxRemoteAudioBytes: integerEnv("MAX_REMOTE_AUDIO_BYTES", 25 * 1024 * 1024),
  remoteAudioTimeoutMs: integerEnv("REMOTE_AUDIO_TIMEOUT_MS", 20_000),
  projectAudioStagedTtlMs: integerEnv("PROJECT_AUDIO_STAGED_TTL_SECONDS", 3600) * 1000,
  projectAudioMaxFiles: integerEnv("PROJECT_AUDIO_MAX_FILES", 20),
  projectAudioMaxBytes: integerEnv("PROJECT_AUDIO_MAX_BYTES", 250 * 1024 * 1024),
  maxRedirects: integerEnv("MAX_REDIRECTS", 3),
  apiKeys,
  googleOAuthClientId,
  googleOAuthClientSecret,
  googleOAuthConfigured,
  oauthAllowedEmails,
  oauthAllowedDomains,
  oauthAccessTokenTtlSeconds: integerEnv("OAUTH_ACCESS_TOKEN_TTL_SECONDS", 3600),
  oauthRefreshTokenTtlSeconds: integerEnv("OAUTH_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600),
  oauthAuthorizationCodeTtlSeconds: integerEnv("OAUTH_AUTHORIZATION_CODE_TTL_SECONDS", 300),
  oauthLoginStateTtlSeconds: integerEnv("OAUTH_LOGIN_STATE_TTL_SECONDS", 600),
  oauthConsentTtlSeconds: integerEnv("OAUTH_CONSENT_TTL_SECONDS", 300),
  apiAuthRequired: production || googleOAuthConfigured || apiKeys.length > 0,
  apiRateLimitPerMinute: integerEnv("API_RATE_LIMIT_PER_MINUTE", 120),
  apiDailyMutationQuota: integerEnv("API_DAILY_MUTATION_QUOTA", 500),
  apiDailyHeavyQuota: integerEnv("API_DAILY_HEAVY_QUOTA", 60),
  projectAccessTokenTtlSeconds: integerEnv("PROJECT_ACCESS_TOKEN_TTL_SECONDS", 300),
  projectSessionTtlSeconds: integerEnv("PROJECT_SESSION_TTL_SECONDS", 3600),
  mcpMaxSessionsPerPrincipal: integerEnv("MCP_MAX_SESSIONS_PER_PRINCIPAL", 200),
  mcpSessionTtlSeconds: integerEnv("MCP_SESSION_TTL_SECONDS", 1800)
});
