import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";

// Giao diện chỉ hiểu JSON. Mọi nhánh lỗi — kể cả nhánh do middleware chặn trước khi request tới
// được route — phải trả JSON kèm một câu nói được thành lời, nếu không nút bấm sẽ hiện
// "Lỗi hệ thống." hoặc tệ hơn là im lặng không báo gì.
//
// Phải chạy server thật vì các ca ở đây nằm ở tầng middleware: express.raw từ chối content-type,
// express.json gặp thân quá lớn, express.static không thấy tệp. Không tầng nào trong số đó đi
// qua `safe()`/`handle()` của router.

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-error-shape-"));
const PORT = 8991 + Math.floor(Math.random() * 30);
const origin = `http://127.0.0.1:${PORT}`;
const serverEnvironment = {
 ...process.env,
 DATABASE_PATH: path.join(tempDirectory, "error-shape.sqlite"),
 ASSET_DIRECTORY: path.join(tempDirectory, "assets"),
 PORT: String(PORT),
 PUBLIC_BASE_URL: origin
};

describe("mọi nhánh lỗi đều trả JSON nói được thành lời", () => {
 let server, projectId;

 before(async () => {
  server = spawn("node", ["src/http-server.js"], { env: serverEnvironment, stdio: ["ignore", "pipe", "pipe"] });
  for (let attempt = 0; attempt < 80; attempt += 1) {
   try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* server chưa lên */ }
   await new Promise(resolve => setTimeout(resolve, 200));
  }
  const created = await fetch(`${origin}/api/video-analysis/projects`, {
   method: "POST",
   headers: { "content-type": "application/json" },
   body: JSON.stringify({ title: "Lỗi" })
  });
  projectId = (await created.json()).id;
 });

 after(async () => {
  server?.kill();
  await fs.rm(tempDirectory, { recursive: true, force: true });
 });

 const send = async (url, { method = "POST", body, contentType } = {}) => {
  const response = await fetch(`${origin}${url}`, {
   method,
   headers: contentType ? { "content-type": contentType } : undefined,
   body
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, json, text };
 };

 // Cả hai nhánh này đều có sẵn câu giải thích trong code, nhưng vì ném Error thường nên
 // publicError thay bằng "Lỗi hệ thống." và người tải lên mất luôn manh mối.
 test("video sai định dạng hoặc rỗng nói rõ tệp sai ở đâu", async () => {
  const wrongType = await send(`/api/video-analysis/projects/${projectId}/source-upload?filename=a.mkv`, {
   body: Buffer.alloc(2048),
   contentType: "video/x-matroska"
  });
  assert.equal(wrongType.status, 415, `định dạng lạ phải là 415, nhận ${wrongType.status}`);
  assert.match(wrongType.json.message, /MP4/u);
  assert.notEqual(wrongType.json.message, "Lỗi hệ thống.");

  const tooSmall = await send(`/api/video-analysis/projects/${projectId}/source-upload?filename=a.mp4`, {
   body: Buffer.alloc(10),
   contentType: "video/mp4"
  });
  assert.equal(tooSmall.status, 422, `tệp quá nhỏ phải là 422, nhận ${tooSmall.status}`);
  assert.match(tooSmall.json.message, /trống|không hợp lệ/u);
  assert.notEqual(tooSmall.json.message, "Lỗi hệ thống.");
 });

 test("nhạc nền không phải MP3 nói rõ chỉ nhận MP3", async () => {
  const project = await send("/api/projects", { body: JSON.stringify({ title: "Nhạc" }), contentType: "application/json" });
  const carouselId = project.json.id;

  const notMp3 = await send(`/api/projects/${carouselId}/video-audio`, {
   body: Buffer.alloc(4096),
   contentType: "audio/mpeg"
  });
  assert.equal(notMp3.status, 422, `tệp không phải MP3 phải là 422, nhận ${notMp3.status}`);
  assert.match(notMp3.json.message, /MP3/u);
  assert.notEqual(notMp3.json.message, "Lỗi hệ thống.");
 });

 // Ba ca dưới bị middleware chặn trước cả route, nên trước đây rơi vào bộ xử lý mặc định của
 // Express: HTML kèm stack trace. `response.json()` phía studio ném lỗi và nút chết lặng.
 test("thân yêu cầu quá lớn trả JSON 413 chứ không phải HTML", async () => {
  const oversized = await send(`/api/video-analysis/projects/${projectId}/script`, {
   method: "PUT",
   body: JSON.stringify({ note: "x".repeat(2 * 1024 * 1024) }),
   contentType: "application/json"
  });
  assert.equal(oversized.status, 413);
  assert.ok(oversized.json, `phải là JSON, nhận: ${oversized.text.slice(0, 60)}`);
  assert.equal(oversized.json.code, "PAYLOAD_TOO_LARGE");
 });

 test("JSON hỏng trả JSON 400 chứ không phải HTML", async () => {
  const broken = await send("/api/video-analysis/projects", { body: '{"title":', contentType: "application/json" });
  assert.equal(broken.status, 400);
  assert.ok(broken.json, `phải là JSON, nhận: ${broken.text.slice(0, 60)}`);
  assert.match(broken.json.message, /JSON/u);
 });

 test("tệp tĩnh không có trả JSON 404 chứ không phải HTML", async () => {
  const missing = await send("/assets/khong-co-that.png", { method: "GET" });
  assert.equal(missing.status, 404);
  assert.ok(missing.json, `phải là JSON, nhận: ${missing.text.slice(0, 60)}`);
  assert.equal(missing.json.code, "NOT_FOUND");
 });

 // Bộ xử lý lỗi mới đứng cuối chuỗi middleware, nên phải kiểm cả nhánh bình thường: đặt sai chỗ
 // là mọi trang tĩnh cùng chết theo.
 test("trang bình thường vẫn phục vụ như cũ", async () => {
  const page = await fetch(`${origin}/video-studio`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") || "", /text\/html/u);
 });
});
