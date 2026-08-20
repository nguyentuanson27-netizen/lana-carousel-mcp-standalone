import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test, { after } from "node:test";

// Máy chủ chưa cấu hình Vertex là lỗi của người vận hành, nhưng người bấm "Nghe thử" mới là
// người nhìn thấy nó. Trước đây họ nhận nguyên câu tiếng Anh của google-auth-library kèm một URL
// bị cắt dở, còn câu hướng dẫn viết sẵn trong code thì không bao giờ chạy tới.

// Không có tệp credential nào được nhìn thấy, và không dò metadata server: cả hai thứ đó khiến
// bài test đổi kết quả theo chỗ chạy — máy có gcloud đăng nhập sẵn sẽ cho qua nhánh cần kiểm.
const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-tts-config-"));
process.env.CLOUDSDK_CONFIG = workDirectory;
process.env.METADATA_SERVER_DETECTION = "none";
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.VERTEX_AI_PROJECT;

// Bốn kiểu hỏng của biến GOOGLE_APPLICATION_CREDENTIALS. Cả bốn đều lọt qua accessSync(R_OK),
// nên bản kiểm đầu tiên chỉ chặn được đúng một kiểu.
const missingKey = path.join(workDirectory, "bi-mat", "khoa.json");
const malformedKey = path.join(workDirectory, "hong.json");
const wrongTypeKey = path.join(workDirectory, "sai-loai.json");
const directoryKey = workDirectory;
await fs.writeFile(malformedKey, 'day-la-noi-dung-tep-khoa-bi-hong{{{');
await fs.writeFile(wrongTypeKey, JSON.stringify({ type: "khong-phai-loai-nao", client_email: "x@y.z" }));
// Loại được chấp nhận nhưng thiếu đúng những trường JWT.fromJSON() đòi. Kiểm mỗi `type` thì tệp
// này đi lọt tới tận chỗ ngã.
const incompleteKey = path.join(workDirectory, "thieu-truong.json");
await fs.writeFile(incompleteKey, JSON.stringify({ type: "service_account" }));
// Loại này từng lọt qua cổng kiểm cũ: đủ audience/subject_token_type/token_url, nhưng
// IdentityPoolClient vẫn ném ngay trong constructor vì thiếu credential_source hợp lệ. Ứng dụng
// không dùng tới loại này, nên từ chối thẳng thay vì đoán bộ ràng buộc lồng nhau của nó.
const exoticKey = path.join(workDirectory, "external-account.json");
await fs.writeFile(exoticKey, JSON.stringify({
 type: "external_account", audience: "//iam.googleapis.com/x", subject_token_type: "urn:x", token_url: "https://sts.googleapis.com/v1/token"
}));

after(() => fs.rm(workDirectory, { recursive: true, force: true }));

const { generateVideoTtsTrack, safeCause } = await import("./video-tts.js");

const speak = settings => generateVideoTtsTrack(
 { slides: [{ headline: "Xin chào", body: "", video: { enabled: true, caption: "Xin chào" } }] },
 settings
);

test("thiếu project id thì chỉ đúng biến cần đặt chứ không ném câu của thư viện", async () => {
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

// Bốn kiểu hỏng dưới đây đều đi lọt qua bản kiểm "đọc được hay không": thư mục và tệp JSON hỏng
// vẫn readable. google-auth-library đi tiếp rồi ngã ở chỗ sinh ra promise không ai bắt.
const brokenKeys = [
 ["tệp không tồn tại", () => missingKey, /không đọc được/u],
 ["thư mục chứ không phải tệp", () => directoryKey, /thư mục/u],
 ["JSON hỏng", () => malformedKey, /JSON/u],
 ["JSON đúng nhưng không phải credential", () => wrongTypeKey, /chỉ nhận credential loại/u],
 ["loại đúng nhưng thiếu trường bắt buộc", () => incompleteKey, /thiếu trường/u],
 ["loại credential ứng dụng không dùng", () => exoticKey, /chỉ nhận credential loại/u]
];

for (const [label, keyPath, expected] of brokenKeys) {
 test(`credential ${label} bị chặn trước khi chạm vào client`, async () => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath();
  try {
   await assert.rejects(speak({ ttsProvider: "google" }), error => {
    assert.equal(error.code, "TTS_NOT_CONFIGURED");
    assert.match(error.message, expected);
    return true;
   });
  } finally {
   delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
 });
}

// getProjectId() tự đọc chính tệp khoá để dò project id, nên nếu kiểm tệp chạy sau nó thì tệp
// hỏng bị quy thành "chưa đặt VERTEX_AI_PROJECT" — đẩy người vận hành đi đặt một biến vốn đã đúng.
test("tệp khoá hỏng thì Vertex đổ lỗi cho tệp khoá chứ không cho VERTEX_AI_PROJECT", async () => {
 for (const [label, keyPath] of brokenKeys) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath();
  try {
   await assert.rejects(speak({ ttsProvider: "vertex" }), error => {
    assert.equal(error.code, "TTS_NOT_CONFIGURED");
    assert.doesNotMatch(error.message, /VERTEX_AI_PROJECT/u, `${label}: đổ nhầm sang biến project`);
    return true;
   });
  } finally {
   delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
 }
});

// Log cũng là chỗ rò: lỗi JSON.parse của thư viện mang theo nội dung tệp khoá, lỗi ENOENT mang
// theo đường dẫn. Log đi ra file và vào dịch vụ gom log, thường ở quyền đọc rộng hơn hẳn.
test("không dấu vết nào của đường dẫn hay nội dung tệp khoá lọt vào log", async () => {
 const written = [];
 const realError = console.error;
 console.error = (...parts) => { written.push(parts.map(String).join(" ")); };
 try {
  for (const [, keyPath] of brokenKeys) {
   process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath();
   for (const provider of ["google", "vertex"]) {
    await speak({ ttsProvider: provider }).catch(() => {});
   }
   delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
 } finally {
  console.error = realError;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
 }
 const joined = written.join("\n");
 assert.ok(written.length, "phải có log, nếu không bài này không kiểm được gì");
 for (const marker of ["lana-tts-config", ".json", "noi-dung-tep-khoa", os.tmpdir()]) {
  assert.ok(!joined.includes(marker), `log để lọt "${marker}": ${joined.slice(0, 300)}`);
 }
});

// Bài trên chứng minh hôm nay không có gì lọt vào log, nhưng nó chỉ đi qua các nhánh mà bản kiểm
// tệp bắt được trước — ở đó `cause` rỗng, nên nó không hề chạm tới bộ lọc. Kiểm thẳng bộ lọc để
// nhánh nào lỡ đưa nguyên lỗi vào log sau này vẫn bị chặn.
test("bộ lọc log giữ lại tên lỗi và bỏ hết nguyên văn", () => {
 const error = Object.assign(
  new SyntaxError('Unexpected token \'d\', "day-la-noi-dung-tep-khoa" is not valid JSON'),
  { code: "ERR_PARSE" }
 );
 const line = safeCause(error);
 assert.match(line, /SyntaxError/u, "vẫn phải lần ra được lỗi gì");
 assert.match(line, /code=ERR_PARSE/u);
 assert.ok(!line.includes("noi-dung-tep-khoa"), `để lọt nội dung tệp: ${line}`);
 assert.ok(!line.includes("Unexpected token"), `để lọt nguyên văn: ${line}`);

 const withPath = safeCause(Object.assign(new Error("lstat '/etc/lana/khoa.json'"), { code: "ENOENT" }));
 assert.ok(!withPath.includes("/etc/lana"), `để lọt đường dẫn: ${withPath}`);
 assert.equal(safeCause(null), "", "không có cause thì không ghi gì thêm");
});

// Thông báo đi ra tới cả phiên chia sẻ link. Đường dẫn tệp khoá đã đành, lỗi JSON.parse của
// google-auth-library còn nhét nguyên nội dung tệp khoá vào câu báo.
test("không thông báo nào để lọt đường dẫn hay nội dung tệp khoá", async () => {
 for (const [, keyPath] of brokenKeys) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath();
  try {
   for (const provider of ["google", "vertex"]) {
    await assert.rejects(speak({ ttsProvider: provider }), error => {
     assert.doesNotMatch(error.message, /bi-mat|\.json|lana-tts-config/u, `lọt đường dẫn: ${error.message}`);
     assert.doesNotMatch(error.message, /noi-dung-tep-khoa/u, `lọt nội dung tệp: ${error.message}`);
     return true;
    });
   }
  } finally {
   delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
 }
});

// Lọc bằng biểu thức chính quy là lọc đen và kiểu gì cũng sót: đường dẫn Windows không có dấu
// gạch chéo xuôi nào để bắt. Danh sách trắng thì không có khe nào để sót.
test("lỗi lạ chỉ ra câu chung, không mang theo chữ nào của lỗi gốc", async () => {
 const originalFetch = globalThis.fetch;
 const leaky = [
  String.raw`Cannot read C:\Users\deploy\secret-key.json`,
  String.raw`Failed on \\lana-nas\keys\vertex.json`,
  "Cannot read /etc/lana/secret-key.json — see https://noi-bo.lanadesign.tech/help",
  "BEGIN PRIVATE KEY MIIEvQIBADANBgkqhkiG9w0"
 ];
 try {
  for (const raw of leaky) {
   globalThis.fetch = async () => { throw new Error(raw); };
   await assert.rejects(speak({ ttsProvider: "google" }), error => {
    assert.match(error.message, /lỗi chưa rõ, xem log máy chủ/u, `không rơi vào câu chung: ${error.message}`);
    for (const word of ["secret-key", "C:", "lana-nas", "/etc/", "noi-bo", "PRIVATE KEY"]) {
     assert.ok(!error.message.includes(word), `để lọt "${word}": ${error.message}`);
    }
    return true;
   });
  }
 } finally {
  globalThis.fetch = originalFetch;
 }
});

// Bịt đường ra phía người dùng mà để log ghi nguyên văn thì chỉ đổi chỗ rò. Nhánh catch chung
// của generateVideoTtsTrack là một dòng khác hẳn với notConfigured(), nên phải kiểm riêng — chính
// các fixture ở bài trên đã làm "BEGIN PRIVATE KEY" hiện ra trong log CI qua đúng dòng đó.
test("nhánh catch chung cũng không ghi nguyên văn lỗi vào log", async () => {
 const originalFetch = globalThis.fetch;
 const written = [];
 const realError = console.error;
 console.error = (...parts) => { written.push(parts.map(String).join(" ")); };
 try {
  for (const raw of [
   String.raw`Cannot read C:\Users\deploy\secret-key.json`,
   String.raw`Failed on \\lana-nas\keys\vertex.json`,
   "Cannot read /etc/lana/secret-key.json — see https://noi-bo.lanadesign.tech/help",
   "BEGIN PRIVATE KEY MIIEvQIBADANBgkqhkiG9w0"
  ]) {
   globalThis.fetch = async () => { throw new Error(raw); };
   await speak({ ttsProvider: "google" }).catch(() => {});
  }
 } finally {
  console.error = realError;
  globalThis.fetch = originalFetch;
 }
 const joined = written.join("\n");
 assert.ok(written.length, "nhánh này phải có ghi log, nếu không bài test không kiểm được gì");
 for (const marker of ["secret-key", "C:", "lana-nas", "/etc/", "noi-bo", "PRIVATE KEY", "MIIEvQ"]) {
  assert.ok(!joined.includes(marker), `log để lọt "${marker}": ${joined.slice(0, 300)}`);
 }
 assert.match(joined, /TTS failed/u, "vẫn phải lần ra được là nhà cung cấp nào hỏng");
});

// Lý do đã biết vẫn phải nói được thành lời, nếu không thì bản sửa này chỉ đổi "Lỗi hệ thống."
// thành một câu chung khác và người dùng vẫn không biết cần làm gì.
test("lý do đã biết vẫn được nói ra", async () => {
 const originalFetch = globalThis.fetch;
 const cases = [
  ["getaddrinfo ENOTFOUND translate.google.com", /không kết nối được/u],
  ["Unable to detect a Project Id in the current environment.", /project id/u],
  ["Quota exceeded: RESOURCE_EXHAUSTED", /hạn mức/u],
  ["PERMISSION_DENIED: caller lacks permission", /không đủ quyền/u]
 ];
 try {
  for (const [raw, expected] of cases) {
   globalThis.fetch = async () => { throw new Error(raw); };
   await assert.rejects(speak({ ttsProvider: "google" }), error => {
    assert.match(error.message, expected, `phân loại sai "${raw}": ${error.message}`);
    return true;
   });
  }
 } finally {
  globalThis.fetch = originalFetch;
 }
});

// Bài quyết định: promise bị bỏ rơi của google-gax làm Node 22 ném uncaught exception và hạ cả
// tiến trình. Bắt trong cùng tiến trình test không chứng minh được điều đó — phải chạy ra tiến
// trình con rồi xem nó còn sống hay không.
const run = promisify(execFile);
test("tệp khoá hỏng kiểu nào, nhà cung cấp nào, cũng không hạ được tiến trình", async () => {
 const script = path.join(workDirectory, "chay-thu.mjs");
 await fs.writeFile(script, `
  const { generateVideoTtsTrack } = await import(${JSON.stringify(path.resolve("src/video-tts.js"))});
  for (const provider of ["google", "vertex"]) {
   try { await generateVideoTtsTrack({slides:[{headline:"a",body:"",video:{enabled:true,caption:"a"}}]},{ttsProvider:provider}); }
   catch { /* lỗi có kiểm soát là điều mong đợi */ }
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  console.log("SONG_SOT");
 `);

 for (const [label, keyPath] of brokenKeys) {
  const environment = {
   ...process.env,
   GOOGLE_APPLICATION_CREDENTIALS: keyPath(),
   METADATA_SERVER_DETECTION: "none",
   CLOUDSDK_CONFIG: workDirectory
  };
  delete environment.GOOGLE_CLOUD_PROJECT;
  const { stdout } = await run(process.execPath, [script], { env: environment, timeout: 20000 });
  assert.match(stdout, /SONG_SOT/u, `tiến trình chết vì credential ${label}`);
 }
});
