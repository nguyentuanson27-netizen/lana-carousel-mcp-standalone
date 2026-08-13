import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { videoAnalysisAssetDir } from "./video-analysis-service.js";
import { decodeAudioDataUrl, measureAudioDuration } from "./video-audio-file.js";
import { generateSpeechForText } from "./video-tts.js";

const AUDIO_EXTENSIONS = ["wav", "mp3", "ogg", "webm"];
const CACHE_RETENTION_MS = 30 * 864e5;

// Tệp được đặt tên theo băm nội dung nên cùng một câu, cùng giọng là cùng một tệp: render lại
// sau khi chỉ sửa phụ đề hay màu sắc sẽ không gọi lại TTS. Tốc độ đọc không nằm trong khoá vì
// nó được áp bằng playbackRate lúc render, không đổi byte audio mà nhà cung cấp trả về.
export function ttsCacheKey({ text, settings = {} }) {
 const provider = ["gemini", "vertex"].includes(settings.ttsProvider) ? "vertex" : "google";
 const payload = provider === "vertex"
  ? {
   provider,
   text: String(text || ""),
   voice: settings.geminiSpeaker1Voice || "Kore",
   style: settings.geminiStylePrompt || "",
   model: settings.geminiModel || ""
  }
  : { provider, text: String(text || ""), voice: settings.ttsVoice || "" };
 return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 40);
}

const cacheFilename = (key, extension) => `tts-${key}.${extension}`;

export function cachedTtsUrl(filename) {
 return `${config.publicBaseUrl.replace(/\/$/u, "")}/video-analysis-assets/${encodeURIComponent(filename)}`;
}

// Định dạng nào không tự đo được độ dài thì chỉ còn con số ước lượng do nhà cung cấp trả về,
// và con số đó biến mất ở những lần dùng lại sau. Ghi kèm một tệp nhỏ để giữ lại nó.
const estimatePath = key => path.join(videoAnalysisAssetDir, `tts-${key}.estimate.json`);

async function readCachedEstimate(key) {
 const raw = await fs.readFile(estimatePath(key), "utf8").catch(() => "");
 const parsed = raw ? Number(JSON.parse(raw)?.estimatedDuration) : 0;
 return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function readCachedTts(key) {
 for (const extension of AUDIO_EXTENSIONS) {
  const filename = cacheFilename(key, extension);
  const filePath = path.join(videoAnalysisAssetDir, filename);
  const buffer = await fs.readFile(filePath).catch(() => null);
  if (!buffer?.length) continue;
  // Chạm vào tệp để vòng dọn dẹp theo thời gian giữ lại những câu còn đang dùng.
  const touched = new Date();
  await fs.utimes(filePath, touched, touched).catch(() => {});
  return { filename, filePath, extension, buffer, cached: true };
 }
 return null;
}

async function writeCachedTts(key, { buffer, extension }) {
 const filename = cacheFilename(key, extension);
 const filePath = path.join(videoAnalysisAssetDir, filename);
 // Hai render song song có thể sinh cùng một câu; ghi tạm rồi đổi tên để không ai đọc phải
 // tệp mới ghi được một nửa.
 const stagingPath = `${filePath}.${process.pid}-${Date.now()}.part`;
 await fs.writeFile(stagingPath, buffer);
 await fs.rename(stagingPath, filePath).catch(async error => {
  await fs.unlink(stagingPath).catch(() => {});
  throw error;
 });
 return { filename, filePath, extension, buffer, cached: false };
}

export async function synthesizeCachedSpeech({ text, settings, synthesize = generateSpeechForText }) {
 if (!String(text || "").trim()) return null;
 const key = ttsCacheKey({ text, settings });
 let audio = await readCachedTts(key);
 let estimatedDuration = 0;

 if (!audio) {
  const track = await synthesize(text, settings);
  if (!track?.dataUrl) return null;
  const decoded = decodeAudioDataUrl(track.dataUrl);
  estimatedDuration = Number(track.durationSeconds || 0);
  audio = await writeCachedTts(key, decoded);
  if (!measureAudioDuration(decoded.buffer, decoded.extension) && estimatedDuration > 0) {
   await fs.writeFile(estimatePath(key), JSON.stringify({ estimatedDuration })).catch(() => {});
  }
 }

 const duration = measureAudioDuration(audio.buffer, audio.extension);
 return {
  ...audio,
  url: cachedTtsUrl(audio.filename),
  duration,
  measured: duration > 0,
  estimatedDuration: estimatedDuration || (duration ? 0 : await readCachedEstimate(key))
 };
}

export async function purgeExpiredTtsCache({ retentionMs = CACHE_RETENTION_MS } = {}) {
 const entries = await fs.readdir(videoAnalysisAssetDir, { withFileTypes: true }).catch(() => []);
 const deadline = Date.now() - retentionMs;
 let removed = 0;
 for (const entry of entries) {
  const match = entry.isFile() && /^tts-([0-9a-f]{40})\.(wav|mp3|ogg|webm)$/u.exec(entry.name);
  if (!match) continue;
  const filePath = path.join(videoAnalysisAssetDir, entry.name);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.mtimeMs >= deadline) continue;
  await fs.unlink(filePath).catch(() => {});
  // Tệp ước lượng đi kèm phải ra đi cùng lúc, nếu không nó sẽ ở lại vĩnh viễn.
  await fs.unlink(estimatePath(match[1])).catch(() => {});
  removed += 1;
 }
 return { removed };
}
