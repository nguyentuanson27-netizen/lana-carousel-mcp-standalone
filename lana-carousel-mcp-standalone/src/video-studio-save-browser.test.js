import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";

// Thân yêu cầu mà studio gửi lên chỉ tồn tại trong trình duyệt: nó được ghép từ các ô của form
// ngay lúc bấm nút. Bài test phía server có mô phỏng lại thân đó, nhưng bản mô phỏng có thể trôi
// khỏi bản thật lúc nào không hay — chính khoảng trôi đó là chỗ lỗi "Lỗi hệ thống." đã nằm im
// qua nhiều lần phát hành. Ở đây bấm đúng cái nút thật.

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-video-save-"));
const PORT = 8961 + Math.floor(Math.random() * 30);
const origin = `http://127.0.0.1:${PORT}`;
const serverEnvironment = {
 ...process.env,
 DATABASE_PATH: path.join(tempDirectory, "video-save.sqlite"),
 ASSET_DIRECTORY: path.join(tempDirectory, "assets"),
 PORT: String(PORT),
 PUBLIC_BASE_URL: origin
};

let browser = null, skipReason = chromium ? false : "chưa cài playwright";
if (chromium) {
 const executablePath = process.env.CHROMIUM_PATH;
 try { browser = await chromium.launch(executablePath ? { executablePath } : {}); }
 catch (error) { skipReason = `không mở được Chromium: ${error.message.split("\n")[0]}`; }
}

describe("các nút của video studio lưu được thiết lập", { skip: skipReason }, () => {
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
   body: JSON.stringify({ title: "Nút studio" })
  });
  projectId = (await created.json()).id;
 });

 after(async () => {
  server?.kill();
  await browser?.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
 });

 /** Mở studio, thêm một đoạn có lời đọc rồi bấm nút được chỉ định. Trả về các hộp thoại đã hiện. */
 async function clickStudioButton(selector) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const dialogs = [], errors = [];
  page.on("dialog", dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(`${origin}/video-studio?projectId=${projectId}`, { waitUntil: "networkidle" });

  await page.click("#addSegment");
  await page.fill(".segment .sub", "Phụ đề thử");
  await page.fill(".segment .voice", "Lời đọc thử");
  await page.fill(".segment .start", "0");
  await page.fill(".segment .end", "3");

  const response = page.waitForResponse(
   value => value.url().includes(`/projects/${projectId}/script`) && value.request().method() === "PUT",
   { timeout: 10000 }
  );
  await page.click(selector);
  const status = await response.then(value => value.status(), () => 0);
  await page.waitForTimeout(300);
  await page.close();
  return { dialogs, errors, status };
 }

 test("lưu bản nháp không báo lỗi hệ thống", async () => {
  const { dialogs, errors, status } = await clickStudioButton("#save");
  assert.equal(status, 200, `PUT /script phải trả 200, nhận ${status}`);
  assert.deepEqual(dialogs, [], `không được hiện hộp thoại lỗi: ${dialogs.join(" | ")}`);
  assert.deepEqual(errors, [], `studio báo lỗi: ${errors.join(" | ")}`);

  const project = await (await fetch(`${origin}/api/video-analysis/projects/${projectId}`)).json();
  assert.equal(project.script.segments.length, 1, "đoạn vừa thêm phải được lưu lại");
  assert.equal(project.script.segments[0].voiceOverText, "Lời đọc thử");
 });

 // Nút gọi mạng mà không bắt lỗi thì promise bị bỏ rơi: lỗi chỉ nằm trong console còn người dùng
 // thấy một cái nút bấm xong không có gì xảy ra — khó lần ra hơn cả một thông báo sai.
 test("gắn URL video hỏng thì báo lỗi chứ không im lặng", async () => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const dialogs = [];
  page.on("dialog", dialog => { dialogs.push(dialog.message()); dialog.dismiss().catch(() => {}); });
  await page.goto(`${origin}/video-studio?projectId=${projectId}`, { waitUntil: "networkidle" });

  await page.fill("#sourceUrl", "không-phải-url");
  await page.click("#attach");
  await page.waitForTimeout(600);
  await page.close();

  assert.equal(dialogs.length, 1, "phải hiện đúng một thông báo lỗi");
  assert.notEqual(dialogs[0], "Lỗi hệ thống.", "thông báo phải nói được trường nào sai");
 });

 // Thẻ a không có href thì bấm vào không xảy ra gì cả — nút vẫn sáng, vẫn bấm được, và người
 // dùng không có cách nào biết là chưa có video để tải.
 test("nút Tải MP4 chưa hiện khi chưa render xong", async () => {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.goto(`${origin}/video-studio?projectId=${projectId}`, { waitUntil: "networkidle" });
  assert.equal(await page.locator("#download").isVisible(), false, "chưa render thì không được hiện nút tải");
  await page.close();
 });

 test("duyệt script không báo lỗi hệ thống", async () => {
  const { dialogs, status } = await clickStudioButton("#approve");
  assert.equal(status, 200, `PUT /script phải trả 200, nhận ${status}`);
  assert.deepEqual(dialogs, [], `không được hiện hộp thoại lỗi: ${dialogs.join(" | ")}`);

  const project = await (await fetch(`${origin}/api/video-analysis/projects/${projectId}`)).json();
  assert.equal(project.status, "APPROVED");
 });
});
