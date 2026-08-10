import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";

// Thao tác kéo để đổi trọng tâm chỉ tồn tại trong trình duyệt, nên bài test này chạy studio thật
// rồi phát sự kiện con trỏ lên khung xem trước. Các bài parity đặt thẳng `assetCrops` nên không
// chạm tới đường này.

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-gesture-"));
const assetDirectory = path.join(tempDirectory, "assets");
await fs.mkdir(assetDirectory, { recursive: true });

const PORT = 8907 + Math.floor(Math.random() * 40);
const origin = `http://127.0.0.1:${PORT}`;
const serverEnvironment = {
  ...process.env,
  DATABASE_PATH: path.join(tempDirectory, "gesture.sqlite"),
  ASSET_DIRECTORY: assetDirectory,
  PORT: String(PORT),
  PUBLIC_BASE_URL: origin
};

process.env.DATABASE_PATH = serverEnvironment.DATABASE_PATH;
process.env.ASSET_DIRECTORY = assetDirectory;
const { db } = await import(`./db.js?gesture=${Date.now()}`);
const service = await import(`./service-core.js?gesture=${Date.now()}`);

let browser = null, skipReason = chromium ? false : "chưa cài playwright";
if (chromium) {
  const executablePath = process.env.CHROMIUM_PATH;
  try { browser = await chromium.launch(executablePath ? { executablePath } : {}); }
  catch (error) { skipReason = `không mở được Chromium: ${error.message.split("\n")[0]}`; }
}

/** Dựng một slide đã duyệt, ghép lưới hai ảnh, để studio mở thẳng được bước "Sửa thiết kế". */
async function seedApprovedGridProject() {
  const project = service.createProject({ title: "Gesture" });
  const slide = service.addSlide({ projectId: project.id, position: 1, subject: "S", headline: "Tiêu đề", body: "Nội dung" });
  const stamp = new Date().toISOString();
  const assetIds = ["66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777"];
  for (const [index, assetId] of assetIds.entries()) {
    const size = 400, raw = Buffer.alloc(size * size * 3);
    for (let offset = 0; offset < raw.length; offset += 3) { raw[offset + index] = 220; }
    await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path.join(assetDirectory, `g${index}.png`));
    db.prepare(`INSERT INTO assets (id,project_id,storage_key,public_url,mime_type,file_size,width,height,sha256,source_image_url,source_type,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(assetId, project.id, `g${index}.png`, `${origin}/assets/g${index}.png`, "image/png", 100, size, size, `sha-gesture-${index}`, "https://example.com/g.png", "unknown", stamp);
    db.prepare("INSERT OR IGNORE INTO slide_asset_candidates (slide_id,asset_id,created_at) VALUES (?,?,?)").run(slide.id, assetId, stamp);
  }
  service.approveProjectContent(project.id);
  service.approveSlideAssets({ projectId: project.id, slideId: slide.id, assetIds, mode: "grid" });
  return { projectId: project.id, slideId: slide.id, assetIds };
}

describe("kéo trên khung xem trước đổi trọng tâm đúng tỉ lệ", { skip: skipReason }, () => {
  let server, seeded;

  before(async () => {
    seeded = await seedApprovedGridProject();
    db.close();
    server = spawn("node", ["src/http-server.js"], { env: serverEnvironment, stdio: ["ignore", "pipe", "pipe"] });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await fetch(`${origin}/health`)).ok) break; } catch { /* server chưa lên */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  });

  after(async () => {
    server?.kill();
    await browser?.close();
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  /**
   * Mở studio ở bước sửa thiết kế rồi kéo trên ô đầu tiên theo một chuỗi độ dời dọc.
   * `waypoints` là các mốc `dy` tính từ điểm bấm chuột, đi lần lượt trước khi thả.
   * `stepsPerLeg` là số sự kiện chuột cho mỗi chặng: để 1 khi cần chặng cuối rơi đúng vào một mốc,
   * để lớn hơn khi muốn mô phỏng một đường kéo liên tục.
   */
  async function dragFirstCell(waypoints, zoom, stepsPerLeg = 8) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`${origin}/widget?projectId=${seeded.projectId}`, { waitUntil: "networkidle" });
    await page.click('.step[data-view="edit"]');
    await page.waitForSelector(`[data-canvas="${seeded.slideId}"] [data-cell]`);

    await page.locator('[data-editor] [data-control="cropZoom"]').first().evaluate((input, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, zoom);
    await page.waitForTimeout(50);

    const cell = page.locator(`[data-canvas="${seeded.slideId}"] [data-cell]`).first();
    const canvas = page.locator(`[data-canvas="${seeded.slideId}"]`);
    const box = await cell.boundingBox(), canvasBox = await canvas.boundingBox();
    const readY = () => page.evaluate(() => Number(document.querySelector('[data-value-for="cropY"]').textContent.replace("%", "")));
    const before = await readY();

    const startX = box.x + box.width / 2, startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (const dy of waypoints) {
      await page.mouse.move(startX, startY + dy, { steps: stepsPerLeg });
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await readY();
    await page.close();
    assert.deepEqual(errors, [], `studio báo lỗi: ${errors.join(" | ")}`);
    return { before, after, cellHeight: box.height, canvasHeight: canvasBox.height };
  }

  const clampPercent = value => Math.min(100, Math.max(0, value));

  test("kéo được chuẩn hoá theo ô đang chỉnh, không phải theo cả canvas", async () => {
    const zoom = 2, dy = -60;
    const { before, after, cellHeight, canvasHeight } = await dragFirstCell([dy], zoom);
    // Lưới hai ảnh xếp một cột hai hàng nên ô cao bằng nửa canvas — đây là chỗ hai cách chuẩn hoá
    // cho kết quả khác nhau.
    assert.ok(Math.abs(cellHeight - canvasHeight / 2) < 4, "bố cục thử phải là lưới hai hàng");

    const expected = clampPercent(before - dy / (cellHeight * (zoom - 1)) * 100);
    assert.ok(Math.abs(after - expected) <= 3,
      `trọng tâm dọc phải tới ~${expected.toFixed(1)}%, nhận ${after}% (ô cao ${cellHeight.toFixed(0)}px)`);

    const canvasNormalised = clampPercent(before - dy / (canvasHeight * (zoom - 1)) * 100);
    assert.ok(Math.abs(after - canvasNormalised) > 3,
      `chuẩn hoá theo canvas sẽ cho ~${canvasNormalised.toFixed(1)}%, kết quả không được trùng giá trị đó`);
  });

  test("kéo đi rồi kéo về đúng chỗ cũ trả lại trọng tâm ban đầu", async () => {
    // Nếu phép kiểm tra "không đổi" so với trọng tâm lúc bấm chuột thay vì giá trị đang áp dụng,
    // chặng quay về sẽ bị bỏ qua và bản nháp kẹt ở vị trí trung gian.
    // Mỗi chặng đúng một sự kiện chuột: chặng quay về phải rơi chính xác vào điểm xuất phát,
    // nếu chia nhỏ thì các bước trung gian sát điểm gốc sẽ che mất lỗi.
    const { before, after } = await dragFirstCell([-60, 0], 2, 1);
    assert.ok(Math.abs(after - before) <= 1,
      `quay về điểm xuất phát phải cho lại ~${before}%, nhận ${after}%`);
  });

  test("thao tác kéo chạy hết quãng đường chứ không đứt sau vài pixel", async () => {
    // Trước đây `remember()` gọi giữa lúc kéo làm đổi DOM, MutationObserver của stitch-ui.js chạy
    // và cướp mất pointer capture nên chỉ vài pixel đầu được áp dụng.
    const zoom = 2, small = await dragFirstCell([-12], zoom), large = await dragFirstCell([-60], zoom);
    const smallShift = Math.abs(small.after - small.before), largeShift = Math.abs(large.after - large.before);
    assert.ok(largeShift > smallShift * 3,
      `kéo xa gấp năm phải dịch nhiều hơn hẳn: ${smallShift.toFixed(1)}% so với ${largeShift.toFixed(1)}%`);
  });
});
