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
const { lucylabJsonRpc, waitForLucylabExport } = await import("./lucylab-client.js");

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

test("keeps provider-specific voice IDs from leaking into Google TTS", () => {
 const lucylabVoice = tts.LUCYLAB_VOICE_IDS[1];
 assert.equal(tts.resolveGoogleVoice({ ttsVoice: lucylabVoice }), tts.GOOGLE_DEFAULT_VOICE);
 assert.deepEqual(tts.allowedSampleVoices({ ttsVoice: lucylabVoice }, "google"), tts.GOOGLE_VOICES);
 assert.equal(
  ttsCacheKey({ text: "Một câu", settings: { ttsProvider: "google", ttsVoice: lucylabVoice } }),
  ttsCacheKey({ text: "Một câu", settings: { ttsProvider: "google", ttsVoice: tts.GOOGLE_DEFAULT_VOICE } })
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
  const keepAlive = setTimeout(() => resolve({ ok: true, json: async () => ({ result: {} }) }), 1000);
  options.signal.addEventListener("abort", () => {
   clearTimeout(keepAlive);
   reject(options.signal.reason);
  }, { once: true });
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

test("Lucylab export polling obeys one total deadline across waits and requests", async () => {
 let clock = 0;
 const requestTimeouts = [];
 await assert.rejects(
  waitForLucylabExport({
   projectExportId: "export-1",
   totalTimeoutMs: 10_000,
   pollIntervalMs: 2_000,
   now: () => clock,
   delay: async ms => { clock += ms; },
   requestStatus: async timeoutMs => {
    requestTimeouts.push(timeoutMs);
    clock += Math.min(3_000, timeoutMs);
    return { state: "processing" };
   }
  }),
  error => error?.code === "TTS_PROVIDER_FAILED" && error?.status === 504
 );
 assert.equal(clock, 10_000);
 assert.deepEqual(requestTimeouts, [10_000, 5_000]);
});

test("safe remote-audio downloader rejects loopback export URLs before making a request", async () => {
 await assert.rejects(
  downloadRemoteAudioBuffer("https://127.0.0.1/lucylab.wav"),
  error => error?.code === "SSRF_BLOCKED"
 );
});

test("every public settings boundary accepts only the curated Lucylab voice IDs", async () => {
 const [routes, mcp, http] = await Promise.all([
  fs.readFile(new URL("./video-analysis-routes.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./mcp-tools.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./http-server.js", import.meta.url), "utf8")
 ]);
 for (const [name, source] of [["video-analysis", routes], ["MCP", mcp], ["carousel API", http]]) {
  assert.match(
   source,
   /lucylabVoice\s*:\s*z\.enum\(LUCYLAB_VOICE_IDS\)/u,
   `${name} must reject unsupported Lucylab voice IDs instead of persisting a value the renderer will ignore`
  );
 }
});

test("Carousel Studio does not advertise Lucylab until it has a complete supported flow", async () => {
 const widget = await fs.readFile(new URL("../public/widget.js", import.meta.url), "utf8");
 assert.doesNotMatch(widget, /videoLucylabVoice|value="lucylab"/u);
});

test("returns only a coarse Lucylab credit estimate from the legacy account method", async () => {
 const originalFetch = globalThis.fetch;
 const originalKey = process.env.LUCYLAB_API_KEY;
 let requestBody;
 let authorization;
 process.env.LUCYLAB_API_KEY = "test-lucylab-key";
 globalThis.fetch = async (_url, options = {}) => {
  requestBody = JSON.parse(options.body || "{}");
  authorization = options.headers?.Authorization;
  return {
   ok: true,
   status: 200,
   json: async () => ({
    result: {
     user: {
      creditsRemaining: 12345.67,
      isPremium: true,
      subscriptionTier: "pro",
      email: "private@example.com"
     }
    }
   })
  };
 };
 try {
  const result = await tts.getLucylabCredits();
  assert.equal(requestBody.method, "getUserInfo");
  assert.deepEqual(requestBody.input, {});
  assert.equal(authorization, "Bearer test-lucylab-key");
  assert.deepEqual(result, { creditsRemaining: 12300, estimated: true });
 } finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LUCYLAB_API_KEY;
  else process.env.LUCYLAB_API_KEY = originalKey;
 }
});

test("exposes the Lucylab credit estimate only through the project-scoped studio surface", async () => {
 const [html, studio, routes, update] = await Promise.all([
  fs.readFile(new URL("../public/video-studio.html", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/video-studio.js", import.meta.url), "utf8"),
  fs.readFile(new URL("./video-analysis-routes.js", import.meta.url), "utf8"),
  fs.readFile(new URL("../public/update.html", import.meta.url), "utf8")
 ]);
 assert.match(html, /lucylabCreditRow|refreshCreditsBtn|credit tạm tính/u);
 assert.match(studio, /fetchLucylabCredits|lucylab-credits|refreshCreditsBtn/u);
 assert.match(routes, /projects\/:id\/lucylab-credits|getLucylabCredits/u);
 assert.doesNotMatch(routes, /get\("\/lucylab\/credits"/u);
 assert.match(update, /PR #27|Quỳnh Giao|credit tạm tính/u);
 assert.match(update, /PR #26|Lucylab AI/u);
});
