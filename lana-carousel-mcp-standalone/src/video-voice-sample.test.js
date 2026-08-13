import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-voice-sample-test-"));
process.env.DATABASE_PATH = path.join(tempRoot, "voice-sample.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempRoot, "assets");
process.env.PUBLIC_BASE_URL = "https://voice-sample.test";

const { GOOGLE_DEFAULT_VOICE, GOOGLE_VOICES, allowedSampleVoices, voiceSampleSettings, sampledVoiceName } = await import("./video-tts.js");
const { videoAnalysisRouter } = await import("./video-analysis-routes.js");
const service = await import("./video-analysis-service.js");

const app = express();
app.use(express.json());
app.use("/api/video-analysis", videoAnalysisRouter);
const server = app.listen(0);
await new Promise(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const project = service.createVideoAnalysisProject({ title: "Voice sample" });

const postSample = async body => {
 const response = await fetch(`${origin}/api/video-analysis/projects/${project.id}/voice-sample`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
 });
 return { status: response.status, json: await response.json().catch(() => ({})) };
};

// publicError không nhận diện ZodError, nên `.parse()` sẽ biến thân yêu cầu sai thành 500.
// Route phải tự kiểm để những trường hợp này ở lại nhánh 4xx.
test("rejects a malformed voice sample request with 4xx instead of a server error", async () => {
 for (const [label, body] of [
  ["thiếu voice", { ttsProvider: "vertex" }],
  ["provider không tồn tại", { ttsProvider: "elevenlabs", voice: "Kore" }],
  ["voice rỗng", { ttsProvider: "vertex", voice: "" }],
  ["thừa trường lạ", { ttsProvider: "vertex", voice: "Kore", speakingRate: 2 }],
  ["thân rỗng", {}]
 ]) {
  const { status, json } = await postSample(body);
  assert.equal(status, 422, `${label} phải trả 422, nhận ${status}`);
  assert.equal(json.code, "INVALID_VOICE_SAMPLE_REQUEST", label);
 }
});

test("names the offending field so the studio can say what went wrong", async () => {
 const { json } = await postSample({ ttsProvider: "vertex" });
 assert.match(json.message, /voice/u);
});

// Giọng của nhà cung cấp kia sẽ bị bỏ qua lúc tổng hợp, nên phải từ chối thẳng thay vì im lặng
// đọc ra một giọng khác với thứ vừa chọn.
test("refuses a voice belonging to the other provider instead of quietly reading another one", async () => {
 const google = await postSample({ ttsProvider: "google", voice: "Kore" });
 assert.equal(google.status, 422);
 assert.equal(google.json.code, "INVALID_VOICE_SAMPLE_REQUEST");
 assert.match(google.json.message, /vi-VN-Neural2-D/u);

 const vertex = await postSample({ ttsProvider: "vertex", voice: "vi-VN-Neural2-D" });
 assert.equal(vertex.status, 422);
 assert.match(vertex.json.message, /Kore/u);
});

test("applies a Google voice that the picker actually offers", () => {
 const settings = voiceSampleSettings({}, { ttsProvider: "google", voice: "vi-VN-Wavenet-C" });
 assert.equal(settings.ttsVoice, "vi-VN-Wavenet-C");
 assert.equal(sampledVoiceName(settings), "vi-VN-Wavenet-C");
});

// Brief do AI sinh có quyền ghi ttsVoice, nên một dự án có thể đang giữ giọng ngoài danh sách.
// Giọng đó vẫn phải nghe thử được, nếu không studio sẽ từ chối đọc đúng thứ bản render sẽ đọc.
test("keeps a persisted voice outside the picker list sampleable", () => {
 const persisted = { ttsVoice: "vi-VN-Chirp3-HD-Aoede" };
 assert.ok(allowedSampleVoices(persisted, "google").includes("vi-VN-Chirp3-HD-Aoede"));
 assert.deepEqual(allowedSampleVoices({}, "google"), GOOGLE_VOICES);

 const settings = voiceSampleSettings(persisted, { ttsProvider: "google", voice: "vi-VN-Chirp3-HD-Aoede" });
 assert.equal(settings.ttsVoice, "vi-VN-Chirp3-HD-Aoede");
});

// Bộ chọn giọng trong studio chỉ liệt kê giọng Vertex; nhánh Google đọc ttsVoice như một
// voice id đầy đủ của Cloud TTS nên không được nhận những tên đó.
test("applies the picked voice only on the Vertex path", () => {
 for (const provider of ["vertex", "gemini"]) {
  const settings = voiceSampleSettings({ geminiSpeaker1Voice: "Kore" }, { ttsProvider: provider, voice: "Puck" });
  assert.equal(settings.geminiSpeaker1Voice, "Puck");
  assert.equal(settings.ttsVoice, undefined);
  assert.equal(sampledVoiceName(settings), "Puck");
 }
});

test("samples the Google voice that the render path would actually use", () => {
 // Studio chưa bao giờ lưu ttsVoice, nên nghe thử phải rơi về đúng mặc định của render.
 const fallback = voiceSampleSettings({}, { ttsProvider: "google", voice: "Kore" });
 assert.equal(fallback.ttsVoice, GOOGLE_DEFAULT_VOICE);
 assert.notEqual(fallback.ttsVoice, "Kore");
 assert.equal(sampledVoiceName(fallback), GOOGLE_DEFAULT_VOICE);

 // Có cấu hình sẵn thì nghe thử phải dùng đúng giọng đó chứ không phải giá trị bộ chọn.
 const configured = voiceSampleSettings({ ttsVoice: "vi-VN-Wavenet-A" }, { ttsProvider: "google", voice: "Kore" });
 assert.equal(configured.ttsVoice, "vi-VN-Wavenet-A");
 assert.equal(sampledVoiceName(configured), "vi-VN-Wavenet-A");
});

test("reads one speaker at a time even when the project is set up for a dialogue", () => {
 const settings = voiceSampleSettings(
  { geminiMultiSpeaker: true, geminiSpeaker2Voice: "Puck" },
  { ttsProvider: "vertex", voice: "Aoede" }
 );
 assert.equal(settings.geminiMultiSpeaker, false);
});

test("keeps the project's reading style so the sample matches the render", () => {
 const settings = voiceSampleSettings(
  { geminiStylePrompt: "Đọc tiếng Việt sang trọng, tinh tế.", geminiModel: "gemini-2.5-pro-tts" },
  { ttsProvider: "vertex", voice: "Kore" }
 );
 assert.equal(settings.geminiStylePrompt, "Đọc tiếng Việt sang trọng, tinh tế.");
 assert.equal(settings.geminiModel, "gemini-2.5-pro-tts");
});
