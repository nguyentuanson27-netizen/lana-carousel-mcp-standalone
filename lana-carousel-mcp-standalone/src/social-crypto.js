import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";
import { socialConfig } from "./social-config.js";

function decodeKey(raw) {
  const value = String(raw || "").trim();
  if (/^[0-9a-f]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  } catch { /* handled below */ }
  throw new AppError(
    "SOCIAL_ENCRYPTION_NOT_CONFIGURED",
    "SOCIAL_TOKEN_ENCRYPTION_KEY phải là 32 byte (64 ký tự hex hoặc base64 của 32 byte).",
    503
  );
}

export function encryptWithKey(plainText, rawKey) {
  const key = decodeKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(value => value.toString("base64url")).join(".");
}

export function decryptWithKey(value, rawKey) {
  const [ivValue, tagValue, cipherValue] = String(value || "").split(".");
  if (!ivValue || !tagValue || !cipherValue) throw new AppError("SOCIAL_TOKEN_INVALID", "Credential MXH đã lưu không hợp lệ.", 500);
  const key = decodeKey(rawKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(cipherValue, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("SOCIAL_TOKEN_DECRYPT_FAILED", "Không thể giải mã credential MXH.", 500);
  }
}

export function encryptSecret(value) {
  if (!value) return null;
  return encryptWithKey(value, socialConfig.tokenEncryptionKey);
}

export function decryptSecret(value) {
  if (!value) return "";
  return decryptWithKey(value, socialConfig.tokenEncryptionKey);
}

function signPayload(payload, secret) {
  if (!secret) throw new AppError("SOCIAL_SIGNING_NOT_CONFIGURED", "Thiếu secret ký Social Publisher.", 503);
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createOAuthState({ projectId, provider, ttlSeconds = 600 }) {
  const body = Buffer.from(JSON.stringify({
    projectId,
    provider,
    nonce: randomBytes(12).toString("base64url"),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  })).toString("base64url");
  return `${body}.${signPayload(body, socialConfig.oauthStateSecret)}`;
}

export function verifyOAuthState(state, expectedProvider) {
  const [body, signature] = String(state || "").split(".");
  if (!body || !signature) throw new AppError("SOCIAL_OAUTH_STATE_INVALID", "OAuth state không hợp lệ.", 400);
  const expected = signPayload(body, socialConfig.oauthStateSecret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError("SOCIAL_OAUTH_STATE_INVALID", "OAuth state không hợp lệ.", 400);
  let payload;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
  catch { throw new AppError("SOCIAL_OAUTH_STATE_INVALID", "OAuth state không hợp lệ.", 400); }
  if (payload.provider !== expectedProvider || !payload.projectId) throw new AppError("SOCIAL_OAUTH_STATE_INVALID", "OAuth state không đúng provider.", 400);
  if (!Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) throw new AppError("SOCIAL_OAUTH_STATE_EXPIRED", "Phiên kết nối MXH đã hết hạn.", 400);
  return payload;
}

export function signMediaPath(pathname, expires) {
  return signPayload(`${pathname}\n${expires}`, socialConfig.mediaSigningSecret);
}

export function verifyMediaSignature(pathname, expiresValue, signature) {
  const expires = Number(expiresValue);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = signMediaPath(pathname, expires);
  const a = Buffer.from(String(signature || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
