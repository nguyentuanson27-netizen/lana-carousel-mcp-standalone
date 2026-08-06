import "./approval-state-guard.js";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { parseRemoteUrl, resolvePublicHost } from "./ssrf.js";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function contentType(headers) {
  const raw = Array.isArray(headers["content-type"]) ? headers["content-type"][0] : headers["content-type"];
  return String(raw || "").split(";")[0].trim().toLowerCase();
}

async function requestOnce(url, sourcePageUrl) {
  const targets = await resolvePublicHost(url.hostname);
  const client = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LanaCarouselMCP/1.1; +https://content.lanadesign.tech)",
        "Accept": "image/webp,image/png,image/jpeg,*/*;q=0.5",
        "Accept-Encoding": "identity",
        ...(sourcePageUrl ? { Referer: sourcePageUrl } : {})
      },
      lookup: (_hostname, options, callback) => {
        if (options?.all) {
          callback(null, targets);
          return;
        }
        callback(null, targets[0].address, targets[0].family);
      }
    }, (res) => {
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > config.maxImageBytes) {
        res.destroy();
        reject(new AppError("FILE_TOO_LARGE", "Ảnh vượt quá dung lượng cho phép.", 413));
        return;
      }

      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > config.maxImageBytes) {
          res.destroy(new AppError("FILE_TOO_LARGE", "Ảnh vượt quá dung lượng cho phép.", 413));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
      res.on("error", reject);
    });

    req.setTimeout(config.imageTimeoutMs, () => {
      req.destroy(new AppError("REMOTE_TIMEOUT", "Nguồn ảnh phản hồi quá chậm.", 504));
    });
    req.on("error", (error) => {
      console.error("Remote image request failed", {
        host: url.hostname,
        code: error?.code,
        message: error?.message
      });
      reject(error instanceof AppError ? error : new AppError("REMOTE_SOURCE_BLOCKED", "Không tải được ảnh từ nguồn này.", 422));
    });
    req.end();
  });
}

async function download(rawUrl, sourcePageUrl) {
  let url = parseRemoteUrl(rawUrl);
  for (let redirect = 0; ; redirect += 1) {
    const response = await requestOnce(url, sourcePageUrl);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      if (redirect >= config.maxRedirects) {
        throw new AppError("TOO_MANY_REDIRECTS", "Nguồn ảnh chuyển hướng quá nhiều lần.");
      }
      url = parseRemoteUrl(new URL(response.headers.location, url).toString());
      continue;
    }
    if ([401, 403].includes(response.status)) {
      throw new AppError("REMOTE_SOURCE_BLOCKED", "Nguồn ảnh chặn tải trực tiếp.", 422);
    }
    if (response.status === 404) {
      throw new AppError("REMOTE_FILE_NOT_FOUND", "Không tìm thấy ảnh.", 404);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AppError("REMOTE_SOURCE_BLOCKED", `Nguồn ảnh trả HTTP ${response.status}.`, 422);
    }

    const headerType = contentType(response.headers);
    const detected = await fileTypeFromBuffer(response.buffer);
    if (!allowedTypes.has(headerType)) {
      throw new AppError("UNSUPPORTED_IMAGE_TYPE", `Không hỗ trợ ${headerType || "unknown"}.`);
    }
    if (!detected || !allowedTypes.has(detected.mime) || detected.mime !== headerType) {
      throw new AppError("INVALID_IMAGE_FILE", "File tải về không phải ảnh hợp lệ.");
    }
    return { buffer: response.buffer, finalUrl: url.toString() };
  }
}

export async function importAndStoreImage({ imageUrl, sourcePageUrl }) {
  const downloaded = await download(imageUrl, sourcePageUrl);
  let normalized;
  try {
    normalized = await sharp(downloaded.buffer, { failOn: "error", limitInputPixels: 40_000_000 })
      .rotate()
      .webp({ quality: 90, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError("INVALID_IMAGE_FILE", "Không thể giải mã ảnh.");
  }

  const hash = createHash("sha256").update(normalized.data).digest("hex");
  const fileName = `${randomUUID()}.webp`;
  const storageKey = fileName;
  await fs.mkdir(config.assetDirectory, { recursive: true });
  const absolutePath = path.join(config.assetDirectory, fileName);
  await fs.writeFile(absolutePath, normalized.data);

  return {
    storageKey,
    absolutePath,
    publicUrl: `${config.publicBaseUrl}/assets/${fileName}`,
    mimeType: "image/webp",
    fileSize: normalized.data.length,
    width: normalized.info.width,
    height: normalized.info.height,
    sha256: hash,
    finalUrl: downloaded.finalUrl
  };
}
