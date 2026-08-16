import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Studio đọc dự án bằng GET rồi gửi nguyên mảng segment đó lên lại khi lưu. Nếu schema của PUT
// không nhận đúng thứ GET vừa trả về thì mọi nút đi qua đường lưu — lưu bản nháp, duyệt script,
// render video, nghe thử giọng đọc trên video — đều hỏng cùng một lúc.

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-script-round-trip-"));
process.env.DATABASE_PATH = path.join(tempRoot, "round-trip.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempRoot, "assets");
process.env.PUBLIC_BASE_URL = "https://round-trip.test";
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.GOOGLE_CLOUD_PROJECT;

const { videoAnalysisRouter } = await import("./video-analysis-routes.js");
const { generateVideoTtsTrack } = await import("./video-tts.js");
const service = await import("./video-analysis-service.js");

const app = express();
app.use(express.json());
app.use("/api/video-analysis", videoAnalysisRouter);
const server = app.listen(0);
await new Promise(resolve => server.once("listening", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const request = async (method, url, body) => {
 const response = await fetch(`${origin}/api/video-analysis${url}`, {
  method,
  headers: body ? { "content-type": "application/json" } : undefined,
  body: body ? JSON.stringify(body) : undefined
 });
 return { status: response.status, json: await response.json().catch(() => ({})) };
};

// Đúng những gì `settings()` trong public/video-studio.js dựng từ các ô của bảng điều khiển.
const studioSettings = {
 ttsEnabled: true,
 ttsProvider: "vertex",
 ttsSpeed: 1,
 geminiSpeaker1Voice: "Kore",
 ttsVoice: "vi-VN-Neural2-D",
 originalAudioVolume: 0.25,
 ttsVolume: 1,
 subtitleEnabled: true,
 subtitleStyle: "karaoke",
 subtitleFont: "TikTok Sans",
 subtitleSize: 52,
 subtitleColor: "#ffffff",
 subtitleBackgroundColor: "#000000",
 subtitleBackgroundOpacity: 0.72,
 subtitleX: 50,
 subtitlePosition: 86
};

// Đúng những gì `segments()` dựng từ danh sách đoạn, kể cả `order` lấy theo vị trí trong mảng.
const studioSegment = index => ({
 id: `segment-${index}`,
 start: index * 3,
 end: index * 3 + 3,
 subtitleText: `Phụ đề ${index}`,
 voiceOverText: `Lời đọc ${index}`,
 speaker: "speaker1",
 enabled: true,
 order: index
});

test("saves the exact body the studio sends, including the order it read back", async () => {
 const project = service.createVideoAnalysisProject({ title: "Round trip" });
 const { status, json } = await request("PUT", `/projects/${project.id}/script`, {
  approved: false,
  script: { summary: "", language: "vi-VN", segments: [studioSegment(0), studioSegment(1)] },
  settings: studioSettings
 });
 assert.equal(status, 200, `lưu bản nháp phải thành công, nhận ${status}: ${json.message || ""}`);
 assert.equal(json.script.segments.length, 2);
});

// Bài trên còn phải khớp với thứ server thật sự phát ra, nên đọc lại rồi gửi nguyên văn lên.
// Đây mới là ràng buộc chốt: thêm trường nào vào bản lưu thì PUT phải nhận được trường đó.
test("accepts its own output back without editing it", async () => {
 const project = service.createVideoAnalysisProject({ title: "Echo" });
 const saved = await request("PUT", `/projects/${project.id}/script`, {
  approved: false,
  script: { summary: "Tóm tắt", language: "vi-VN", segments: [studioSegment(0)] },
  settings: studioSettings
 });
 assert.equal(saved.status, 200);

 const fetched = await request("GET", `/projects/${project.id}`);
 assert.ok(fetched.json.script.segments.every(segment => "order" in segment), "bản lưu phải có order");

 const echoed = await request("PUT", `/projects/${project.id}/script`, {
  approved: true,
  script: fetched.json.script,
  settings: studioSettings
 });
 assert.equal(echoed.status, 200, `gửi lại nguyên văn phải thành công, nhận ${echoed.status}: ${echoed.json.message || ""}`);
 assert.equal(echoed.json.status, "APPROVED");
});

// Thân yêu cầu sai là lỗi của người gọi. Trả 500 "Lỗi hệ thống." vừa đổ oan cho máy chủ vừa
// giấu mất tên trường sai, khiến một lệch schema nhỏ mất hàng giờ mới tìm ra.
test("reports a malformed body as a client error that names the field", async () => {
 const project = service.createVideoAnalysisProject({ title: "Malformed" });
 const { status, json } = await request("PUT", `/projects/${project.id}/script`, {
  approved: false,
  script: { summary: "", language: "vi-VN", segments: [{ ...studioSegment(0), end: "ba giây" }] },
  settings: studioSettings
 });
 assert.equal(status, 422, `phải là lỗi 4xx, nhận ${status}`);
 assert.equal(json.code, "INVALID_REQUEST");
 assert.match(json.message, /end/u);
 assert.notEqual(json.message, "Lỗi hệ thống.");
});

// Nghe thử gọi thẳng ra nhà cung cấp; lỗi ở đó phải nói được là lỗi gì thì người dùng mới biết
// cần bật credential hay đổi model.
test("surfaces a provider failure with its reason instead of a generic server error", async () => {
 const originalFetch = globalThis.fetch;
 globalThis.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND translate.google.com"); };
 try {
  await assert.rejects(
   generateVideoTtsTrack({ slides: [{ headline: "Xin chào", body: "", video: { enabled: true } }] }, { ttsProvider: "google" }),
   error => {
    assert.equal(error.name, "AppError");
    assert.equal(error.status, 502);
    assert.equal(error.code, "TTS_PROVIDER_FAILED");
    assert.match(error.message, /ENOTFOUND/u);
    return true;
   }
  );
 } finally {
  globalThis.fetch = originalFetch;
 }
});
