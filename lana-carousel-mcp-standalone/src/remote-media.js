import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { parseRemoteUrl, resolvePublicHost } from "./ssrf.js";

const allowedMediaTypes = new Set([
  "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav",
  "video/mp4", "application/octet-stream"
]);

function mime(headers) {
  const raw = Array.isArray(headers["content-type"]) ? headers["content-type"][0] : headers["content-type"];
  return String(raw || "").split(";")[0].trim().toLowerCase();
}

function extensionFor(type) {
  if (type.includes("wav")) return ".wav";
  if (type.includes("mp4") || type.includes("m4a")) return ".m4a";
  return ".mp3";
}

async function requestOnce(url) {
  const targets = await resolvePublicHost(url.hostname);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      headers: {
        "User-Agent": "LanaCarousel/3.1",
        "Accept": "audio/*,video/mp4,application/octet-stream;q=0.6",
        "Accept-Encoding": "identity"
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, targets);
        else callback(null, targets[0].address, targets[0].family);
      }
    }, response => {
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > config.maxRemoteAudioBytes) {
        response.destroy();
        reject(new AppError("AUDIO_TOO_LARGE", "Nhạc nền vượt quá dung lượng cho phép.", 413));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", chunk => {
        total += chunk.length;
        if (total > config.maxRemoteAudioBytes) {
          response.destroy(new AppError("AUDIO_TOO_LARGE", "Nhạc nền vượt quá dung lượng cho phép.", 413));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, headers: response.headers, buffer: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(config.remoteAudioTimeoutMs, () => request.destroy(new AppError("AUDIO_TIMEOUT", "Nguồn nhạc nền phản hồi quá chậm.", 504)));
    request.on("error", error => reject(error instanceof AppError ? error : new AppError("AUDIO_DOWNLOAD_FAILED", "Không tải được nhạc nền.", 422)));
    request.end();
  });
}

export function isTrustedUploadedAudioUrl(raw) {
  try {
    const url = new URL(raw);
    const base = new URL(config.publicBaseUrl);
    return url.origin === base.origin && url.pathname.startsWith("/video-audio/") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function downloadRemoteAudio(rawUrl, directory) {
  let url = parseRemoteUrl(rawUrl);
  for (let redirect = 0; ; redirect += 1) {
    const response = await requestOnce(url);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirect >= config.maxRedirects) throw new AppError("TOO_MANY_REDIRECTS", "Nguồn nhạc chuyển hướng quá nhiều lần.");
      url = parseRemoteUrl(new URL(response.headers.location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new AppError("AUDIO_DOWNLOAD_FAILED", `Nguồn nhạc trả HTTP ${response.status}.`, 422);
    const type = mime(response.headers);
    if (!allowedMediaTypes.has(type)) throw new AppError("UNSUPPORTED_AUDIO_TYPE", `URL nhạc không phải file media trực tiếp (${type || "không rõ"}).`, 422);
    if (response.buffer.length < 128) throw new AppError("INVALID_AUDIO_FILE", "File nhạc nền rỗng hoặc không hợp lệ.", 422);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${randomUUID()}${extensionFor(type)}`);
    await fs.writeFile(file, response.buffer, { flag: "wx" });
    return { file, finalUrl: url.toString(), mimeType: type, size: response.buffer.length };
  }
}
