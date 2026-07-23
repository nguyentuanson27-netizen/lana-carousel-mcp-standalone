import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

function integerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolveFromRoot(value, fallback) {
  return path.resolve(projectRoot, value || fallback);
}

export const config = Object.freeze({
  port: integerEnv("PORT", 8787),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:8787").replace(/\/$/, ""),
  databasePath: resolveFromRoot(process.env.DATABASE_PATH, "./data/lana-carousel.sqlite"),
  assetDirectory: resolveFromRoot(process.env.ASSET_DIRECTORY, "./data/assets"),
  maxImageBytes: integerEnv("MAX_IMAGE_BYTES", 10 * 1024 * 1024),
  imageTimeoutMs: integerEnv("IMAGE_TIMEOUT_MS", 15_000),
  maxRedirects: integerEnv("MAX_REDIRECTS", 3)
});
