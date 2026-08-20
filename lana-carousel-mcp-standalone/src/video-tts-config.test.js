import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Máy chủ chưa cấu hình Vertex là lỗi của người vận hành, nhưng người bấm "Nghe thử" mới là
// người nhìn thấy nó. Trước đây họ nhận nguyên câu tiếng Anh của google-auth-library kèm một URL
// bị cắt dở, còn câu hướng dẫn viết sẵn trong code thì không bao giờ chạy tới.

// Không có tệp credential nào được nhìn thấy, và không dò metadata server: cả hai thứ đó khiến
// bài test đổi kết quả theo chỗ chạy — máy có gcloud đăng nhập sẵn sẽ cho qua nhánh cần kiểm.
const emptyConfigDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-tts-config-"));
process.env.CLOUDSDK_CONFIG = emptyConfigDirectory;
process.env.METADATA_SERVER_DETECTION = "none";
const secretKeyPath = path.join(emptyConfigDirectory, "bi-mat", "khoa.json");
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.VERTEX_AI_PROJECT;

after(() => fs.rm(emptyConfigDirectory, { recursive: true, force: true }));

const { generateVideoTtsTrack } = await import("./video-tts.js");

const speak = settings => generateVideoTtsTrack(
 { slides: [{ headline: "Xin chào", body: "", video: { enabled: true, caption: "Xin chào" } }] },
 settings
);

test("thiếu project id thì chỉ đúng biến cần đặt chứ không ném câu của thư viện", async () => {
 delete process.env.VERTEX_AI_PROJECT;
 await assert.rejects(speak({ ttsProvider: "vertex" }), error => {
  assert.equal(error.name, "AppError");
  assert.equal(error.code, "TTS_NOT_CONFIGURED");
  assert.equal(error.status, 503, "chưa gọi ra ngoài lần nào nên không phải 502");
  assert.match(error.message, /VERTEX_AI_PROJECT/u, "phải nói rõ thiếu biến nào");
  assert.match(error.message, /Google TTS/u, "không có credential nào thì đường lui này thật sự chạy");
  assert.doesNotMatch(error.message, /Unable to detect/u, "không để lọt câu của thư viện");
  return true;
 });
});

// Có project id vẫn chưa chạy được nếu không có credential. Nhánh này nằm ở `getClient()`, tách
// hẳn với nhánh trên, nên phải kiểm riêng — nói nhầm biến thì người vận hành sửa nhầm chỗ.
test("có project nhưng thiếu credential thì nói là thiếu credential", async () => {
 process.env.VERTEX_AI_PROJECT = "lana-test-project";
 try {
  await assert.rejects(speak({ ttsProvider: "vertex" }), error => {
   assert.equal(error.code, "TTS_NOT_CONFIGURED");
   assert.equal(error.status, 503);
   assert.match(error.message, /chưa có credential/u);
   return true;
  });
 } finally {
  delete process.env.VERTEX_AI_PROJECT;
 }
});

// Đặt biến rồi mà trỏ tới tệp không tồn tại là ca dễ gặp nhất khi chạy Docker: compose chỉ mount
// ./data nên đường dẫn của host không có bên trong container. Báo nhầm thành "chưa đặt" sẽ đẩy
// người vận hành đi đặt lại đúng cái biến họ vừa đặt.
test("credential trỏ sai chỗ thì nói đúng biến đó chứ không bảo đi đặt lại", async () => {
 process.env.VERTEX_AI_PROJECT = "lana-test-project";
 process.env.GOOGLE_APPLICATION_CREDENTIALS = secretKeyPath;
 try {
  await assert.rejects(speak({ ttsProvider: "vertex" }), error => {
   assert.equal(error.code, "TTS_NOT_CONFIGURED");
   assert.match(error.message, /GOOGLE_APPLICATION_CREDENTIALS/u);
   assert.match(error.message, /không đọc được/u);
   assert.doesNotMatch(error.message, /chưa đặt/u, "biến đã được đặt, đừng bảo người ta đặt lại");
   assert.doesNotMatch(error.message, /Google TTS/u, "đường lui đó cũng hỏng khi biến này đặt sai");
   return true;
  });
 } finally {
  delete process.env.VERTEX_AI_PROJECT;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
 }
});

// Thông báo này đi ra tới cả phiên chia sẻ link, mà lỗi credential của google-auth-library có
// nguyên đường dẫn tệp khoá trong đó — đủ để người ngoài biết cây thư mục của máy chủ.
test("không thông báo nào để lọt đường dẫn tệp khoá", async () => {
 process.env.GOOGLE_APPLICATION_CREDENTIALS = secretKeyPath;
 try {
  for (const provider of ["vertex", "google"]) {
   await assert.rejects(speak({ ttsProvider: provider }), error => {
    assert.doesNotMatch(error.message, /bi-mat|\.json/u, `${provider} để lọt: ${error.message}`);
    return true;
   });
  }
 } finally {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
 }
});

// Bài trên chỉ chạm tới nhánh kiểm tệp có sẵn. Lỗi từ chính nhà cung cấp mới là chỗ đường dẫn
// thật sự đi lạc ra ngoài, nên phải bắn một lỗi có đường dẫn qua đúng đường đó.
test("đường dẫn và URL trong lỗi nhà cung cấp bị xoá khỏi thông báo", async () => {
 const originalFetch = globalThis.fetch;
 globalThis.fetch = async () => {
  throw new Error("Cannot read /etc/lana/secret-key.json — see https://noi-bo.lanadesign.tech/help");
 };
 try {
  await assert.rejects(speak({ ttsProvider: "google" }), error => {
   assert.doesNotMatch(error.message, /secret-key|\/etc\//u, `để lọt đường dẫn: ${error.message}`);
   assert.doesNotMatch(error.message, /noi-bo|https?:/u, `để lọt URL: ${error.message}`);
   assert.match(error.message, /Cannot read/u, "vẫn phải giữ được lý do");
   return true;
  });
 } finally {
  globalThis.fetch = originalFetch;
 }
});

// Tệp khoá hỏng làm google-gax bỏ lại một promise bị từ chối không ai bắt; Node 22 ném tiếp thành
// uncaught exception và cả tiến trình http-server tắt. Một khoá hết hạn không được phép hạ máy chủ.
test("tệp khoá hỏng không hạ được tiến trình", async () => {
 process.env.GOOGLE_APPLICATION_CREDENTIALS = secretKeyPath;
 const leaked = [];
 const onUnhandled = reason => leaked.push(String(reason?.message || reason));
 process.on("unhandledRejection", onUnhandled);
 try {
  await assert.rejects(speak({ ttsProvider: "google" }), error => {
   assert.equal(error.code, "TTS_NOT_CONFIGURED");
   return true;
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(leaked, [], `promise bị bỏ rơi sẽ giết tiến trình: ${leaked.join(" | ")}`);
 } finally {
  process.off("unhandledRejection", onUnhandled);
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
 }
});

// Lỗi của thư viện Google trải trên nhiều dòng: dòng đầu là lý do, phần sau là link hướng dẫn.
// Cắt cứng theo số ký tự thì người dùng nhận đúng một chữ "h" của cái URL — điều đã thật sự xảy
// ra trên bản chạy thật.
test("lỗi nhiều dòng chỉ giữ dòng đầu, không kéo theo mẩu URL đứt đoạn", async () => {
 const originalFetch = globalThis.fetch;
 globalThis.fetch = async () => {
  throw new Error(
   "Unable to detect a Project Id in the current environment. \n" +
   "To learn more about authentication and Google APIs, visit: \n" +
   "https://cloud.google.com/docs/authentication/getting-started"
  );
 };
 try {
  await assert.rejects(speak({ ttsProvider: "google" }), error => {
   assert.equal(error.code, "TTS_PROVIDER_FAILED");
   assert.doesNotMatch(error.message, /\n/u, "thông báo phải gọn trong một dòng");
   assert.doesNotMatch(error.message, /visit:/u, "không kéo theo phần dẫn link");
   assert.doesNotMatch(error.message, /https?:/u, "và cũng không kéo theo chính cái link");
   assert.match(error.message, /Unable to detect a Project Id/u, "vẫn phải giữ nguyên lý do");
   return true;
  });
 } finally {
  globalThis.fetch = originalFetch;
 }
});

// Cắt ngắn vẫn phải còn hiệu lực với lỗi một dòng nhưng dài, nếu không thân phản hồi của nhà
// cung cấp lại theo thông báo ra tới phiên chia sẻ link.
test("lỗi một dòng quá dài vẫn bị cắt và đánh dấu là đã cắt", async () => {
 const originalFetch = globalThis.fetch;
 globalThis.fetch = async () => { throw new Error(`${"chi tiết nội bộ ".repeat(40)}projects/bi-mat`); };
 try {
  await assert.rejects(speak({ ttsProvider: "google" }), error => {
   assert.ok(error.message.length < 200, `thông báo dài ${error.message.length} ký tự`);
   assert.doesNotMatch(error.message, /projects\/bi-mat/u, "không được lộ phần đuôi");
   assert.match(error.message, /…$/u, "phải thấy được là câu đã bị cắt");
   return true;
  });
 } finally {
  globalThis.fetch = originalFetch;
 }
});
