import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-lucylab-hardening-"));
process.env.DATABASE_PATH = path.join(tempRoot, "lucylab-hardening.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempRoot, "assets");
process.env.PUBLIC_BASE_URL = "https://lucylab-hardening.test";

const tts = await import("./video-tts.js");
const { ttsCacheKey } = await import("./video-tts-cache.js");
const { downloadRemoteAudioBuffer } = await import("./remote-media.js");
const { lucylabJsonRpc } = await import("./lucylab-client.js");

after(async () => {
 await fs.rm(tempRoot, { recursive: true, force: true });
});

test("canonicalizes stale non-Lucylab voices to the Lucylab default", () => {
 assert.equal(tts.resolveLucylabVoice({ ttsVoice: "vi-VN-Neural2-D" }), tts.LUCYLAB_DEFAULT_VOICE);
 assert.equal(tts.resolveLucylabVoice({ lucylabVoice: "unknown-voice" }), tts.LUCYLAB_DEFAULT_VOICE);
 assert.equal(
  tts.resolveLucylabVoice({ lucylabVoice: tts.LUCYLAB_VOICE_IDS[2] }),
  tts.LUCYLAB_VOICE_IDS[2]
 );
});

test("keeps Lucylab synthesis at 1x so render playbackRate owns reading speed", () => {
 const input = tts.lucylabSynthesisInput("Xin chào", {
  ttsSpeed: 2,
  ttsVoice: "vi-VN-Neural2-D"
 });
 assert.deepEqual(input, {
  text: "Xin chào",
  userVoiceId: tts.LUCYLAB_DEFAULT_VOICE,
  speed: 1
 });
});

test("keeps Lucylab cache stable across playback speeds and stale fallback voices", () => {
 const base = { ttsProvider: "lucylab", lucylabVoice: tts.LUCYLAB_DEFAULT_VOICE };
 assert.equal(
  ttsCacheKey({ text: "Một câu", settings: { ...base, ttsSpeed: 0.8 } }),
  ttsCacheKey({ text: "Một câu", settings: { ...base, ttsSpeed: 2 } })
 );
 assert.equal(
  ttsCacheKey({ text: "Một câu", settings: { ttsProvider: "lucylab", ttsVoice: "vi-VN-Neural2-D" } }),
  ttsCacheKey({ text: "Một câu", settings: base })
 );
});

test("does not expose raw Lucylab provider failures to callers", async () => {
 const originalFetch = globalThis.fetch;
 const originalKey = process.env.LUCYLAB_API_KEY;
 let requestBody;
 process.env.LUCYLAB_API_KEY = "test-lucylab-key";
 globalThis.fetch = async (_url, options = {}) => {
  requestBody = JSON.parse(options.body || "{}");
  return {
   ok: false,
   status: 502,
   json: async () => ({ error: { message: "BEGIN PRIVATE KEY provider-secret" } })
  };
 };
 try {
  await assert.rejects(
   tts.generateSpeechForText("Xin chào", {
    ttsProvider: "lucylab",
    ttsSpeed: 2,
    ttsVoice: "vi-VN-Neural2-D"
   }),
   error => {
    assert.equal(error.code, "TTS_PROVIDER_FAILED");
    assert.doesNotMatch(error.message, /BEGIN PRIVATE KEY|provider-secret/u);
    return true;
   }
  );
  assert.equal(requestBody.method, "ttsLongText");
  assert.equal(requestBody.input.speed, 1);
  assert.equal(requestBody.input.userVoiceId, tts.LUCYLAB_DEFAULT_VOICE);
 } finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LUCYLAB_API_KEY;
  else process.env.LUCYLAB_API_KEY = originalKey;
 }
});

test("Lucylab JSON-RPC aborts a hung request at the configured timeout", async () => {
 const originalFetch = globalThis.fetch;
 globalThis.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
  options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
 });
 try {
  const startedAt = Date.now();
  await assert.rejects(
   lucylabJsonRpc({ apiKey: "test-key", method: "ttsLongText", input: {}, timeoutMs: 20 }),
   error => error?.code === "TTS_PROVIDER_FAILED"
  );
  assert.ok(Date.now() - startedAt < 500, "hung Lucylab request should be bounded by timeout");
 } finally {
  globalThis.fetch = originalFetch;
 }
});

test("safe remote-audio downloader rejects loopback export URLs before making a request", async () => {
 await assert.rejects(
  downloadRemoteAudioBuffer("https://127.0.0.1/lucylab.wav"),
  error => error?.code === "SSRF_BLOCKED"
 );
});

test("Carousel Studio does not advertise Lucylab until it has a complete supported flow", async () => {
 const widget = await fs.readFile(new URL("../public/widget.js", import.meta.url), "utf8");
 assert.doesNotMatch(widget, /videoLucylabVoice|value="lucylab"/u);
});

test("undocumented Lucylab credit lookup stays fail-closed and never calls the provider", async () => {
 const originalFetch = globalThis.fetch;
 let called = false;
 globalThis.fetch = async () => { called = true; throw new Error("should not be called"); };
 try {
  await assert.rejects(
   tts.getLucylabCredits(),
   error => error?.code === "TTS_CREDITS_UNAVAILABLE" && error?.status === 501
  );
  assert.equal(called, false);
  const videoTts = await fs.readFile(new URL("./video-tts.js", import.meta.url), "utf8");
  assert.doesNotMatch(videoTts, /getUserInfo/u);
 } finally {
  globalThis.fetch = originalFetch;
 }
});
