import { AppError } from "./errors.js";
import { socialConfig } from "./social-config.js";

export async function socialFetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || socialConfig.requestTimeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : {}; }
    catch { value = { raw: text.slice(0, 500) }; }
    if (!response.ok) {
      const message = value?.error?.message || value?.message || `HTTP ${response.status}`;
      throw new AppError("SOCIAL_PROVIDER_ERROR", `Nhà cung cấp MXH trả lỗi: ${message}`, response.status >= 500 ? 502 : 400);
    }
    return value;
  } catch (error) {
    if (error?.name === "AbortError") throw new AppError("SOCIAL_PROVIDER_TIMEOUT", "Nhà cung cấp MXH phản hồi quá lâu.", 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) if (value !== undefined && value !== null) body.set(key, String(value));
  return body;
}
