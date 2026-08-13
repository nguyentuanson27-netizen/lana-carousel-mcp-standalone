import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-tts-cache-test-"));
process.env.DATABASE_PATH = path.join(tempRoot, "tts-cache.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempRoot, "assets");
process.env.PUBLIC_BASE_URL = "https://tts-cache.test";

const cache = await import("./video-tts-cache.js");
const { videoAnalysisAssetDir } = await import("./video-analysis-service.js");

function wavDataUrl(seconds, sampleRate = 24000) {
 const data = Buffer.alloc(Math.round(sampleRate * seconds) * 2);
 const header = Buffer.alloc(44);
 header.write("RIFF", 0);
 header.writeUInt32LE(36 + data.length, 4);
 header.write("WAVE", 8);
 header.write("fmt ", 12);
 header.writeUInt32LE(16, 16);
 header.writeUInt16LE(1, 20);
 header.writeUInt16LE(1, 22);
 header.writeUInt32LE(sampleRate, 24);
 header.writeUInt32LE(sampleRate * 2, 28);
 header.writeUInt16LE(2, 32);
 header.writeUInt16LE(16, 34);
 header.write("data", 36);
 header.writeUInt32LE(data.length, 40);
 return `data:audio/wav;base64,${Buffer.concat([header, data]).toString("base64")}`;
}

const vertexSettings = { ttsProvider: "vertex", geminiSpeaker1Voice: "Kore", geminiStylePrompt: "Đọc rõ ràng." };

// Tiêm bộ tổng hợp giả để đếm được số lần thật sự gọi ra nhà cung cấp, giống cách
// attachRemoteVideoSource nhận importer trong các test khác.
function stubProvider(dataUrl = wavDataUrl(1.5), durationSeconds = 0) {
 const calls = [];
 return {
  calls,
  synthesize: async (text, settings) => {
   calls.push({ text, settings });
   return { dataUrl, durationSeconds };
  }
 };
}

test("reads the same sentence from cache instead of calling the provider again", async () => {
 const provider = stubProvider();

 const first = await cache.synthesizeCachedSpeech({ text: "Xin chào các bạn", settings: vertexSettings, synthesize: provider.synthesize });
 const second = await cache.synthesizeCachedSpeech({ text: "Xin chào các bạn", settings: vertexSettings, synthesize: provider.synthesize });

 assert.equal(provider.calls.length, 1, "lần thứ hai không được gọi lại TTS");
 assert.equal(first.cached, false);
 assert.equal(second.cached, true);
 assert.equal(second.url, first.url);
 assert.equal(second.duration, 1.5);
 assert.equal(second.measured, true);
});

test("changing the words or the voice makes a new recording, changing only speed does not", async () => {
 const provider = stubProvider();

 const base = await cache.synthesizeCachedSpeech({ text: "Câu gốc", settings: vertexSettings, synthesize: provider.synthesize });
 const otherWords = await cache.synthesizeCachedSpeech({ text: "Câu khác", settings: vertexSettings, synthesize: provider.synthesize });
 const otherVoice = await cache.synthesizeCachedSpeech({
  text: "Câu gốc",
  settings: { ...vertexSettings, geminiSpeaker1Voice: "Puck" }, synthesize: provider.synthesize });
 // Tốc độ đọc được áp bằng playbackRate lúc render, không đổi byte audio nhà cung cấp trả về.
 const otherSpeed = await cache.synthesizeCachedSpeech({
  text: "Câu gốc",
  settings: { ...vertexSettings, ttsSpeed: 1.5 }, synthesize: provider.synthesize });

 assert.notEqual(otherWords.url, base.url);
 assert.notEqual(otherVoice.url, base.url);
 assert.equal(otherSpeed.url, base.url);
 assert.equal(otherSpeed.cached, true);
 assert.equal(provider.calls.length, 3);
});

test("keeps a provider estimate for audio whose length cannot be read back", async () => {
 const provider = stubProvider("data:audio/ogg;base64,T2dnUwACAAAAAAAAAAA=", 4.2);

 const fresh = await cache.synthesizeCachedSpeech({ text: "Định dạng lạ", settings: vertexSettings, synthesize: provider.synthesize });
 assert.equal(fresh.measured, false);
 assert.equal(fresh.estimatedDuration, 4.2);

 // Lần dùng lại không còn con số của nhà cung cấp, phải lấy được từ tệp ghi kèm.
 const reused = await cache.synthesizeCachedSpeech({ text: "Định dạng lạ", settings: vertexSettings, synthesize: provider.synthesize });
 assert.equal(reused.cached, true);
 assert.equal(reused.measured, false);
 assert.equal(reused.estimatedDuration, 4.2);
});

test("returns nothing for empty text without calling the provider", async () => {
 const provider = stubProvider();
 assert.equal(await cache.synthesizeCachedSpeech({ text: "   ", settings: vertexSettings, synthesize: provider.synthesize }), null);
 assert.equal(provider.calls.length, 0);
});

test("drops recordings nobody has used for a while and keeps the fresh ones", async () => {
 const provider = stubProvider();

 const stale = await cache.synthesizeCachedSpeech({ text: "Câu cũ", settings: vertexSettings, synthesize: provider.synthesize });
 const fresh = await cache.synthesizeCachedSpeech({ text: "Câu mới", settings: vertexSettings, synthesize: provider.synthesize });
 const staleKey = cache.ttsCacheKey({ text: "Câu cũ", settings: vertexSettings });
 const estimateFile = path.join(videoAnalysisAssetDir, `tts-${staleKey}.estimate.json`);
 await fs.writeFile(estimateFile, JSON.stringify({ estimatedDuration: 1 }));

 const old = new Date(Date.now() - 40 * 864e5);
 await fs.utimes(stale.filePath, old, old);

 const { removed } = await cache.purgeExpiredTtsCache({ retentionMs: 30 * 864e5 });
 assert.equal(removed, 1);
 assert.equal(await fs.access(stale.filePath).then(() => true, () => false), false);
 // Tệp ước lượng đi kèm phải ra đi cùng, nếu không nó nằm lại vĩnh viễn.
 assert.equal(await fs.access(estimateFile).then(() => true, () => false), false);
 assert.equal(await fs.access(fresh.filePath).then(() => true, () => false), true);
});
