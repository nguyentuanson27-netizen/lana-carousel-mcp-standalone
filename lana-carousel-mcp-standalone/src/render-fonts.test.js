import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-fonts-"));
const assetDirectory = path.join(tempDirectory, "assets");
process.env.DATABASE_PATH = path.join(tempDirectory, "fonts.sqlite");
process.env.ASSET_DIRECTORY = assetDirectory;
await fs.mkdir(assetDirectory, { recursive: true });

const { FONT_FILES, FONT_DIRECTORY, missingFontFiles } = await import("./fonts.js");
const { db } = await import(`./db.js?fonts=${Date.now()}`);
const service = await import(`./service-core.js?fonts=${Date.now()}`);

after(async () => {
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

const backgroundSize = 200;
await sharp(Buffer.alloc(backgroundSize * backgroundSize * 3).fill(40), { raw: { width: backgroundSize, height: backgroundSize, channels: 3 } })
  .png().toFile(path.join(assetDirectory, "bg.png"));
const asset = { id: "bg.png", storageKey: "bg.png" };

function renderText(font, content = "Top 5 brand Việt", weight = "700") {
  const slide = {
    selectedAssetIds: [asset.id], compositionMode: "crop", textEnabled: true,
    textLayers: [{ id: "h", role: "headline", content, enabled: true, font, weight, size: 64, x: 50, y: 50, color: "#FFFFFF", align: "center", opacity: 1, rotation: 0 }]
  };
  return service.renderSlideSnapshot(slide, [asset], { width: 400, height: 640 });
}

const digest = buffer => crypto.createHash("sha256").update(buffer).digest("hex");

test("every font offered by the studio ships with the repo", () => {
  assert.deepEqual(missingFontFiles(), [], "thiếu file font cho font mà studio cho chọn");
});

test("the studio font picker and the bundled font set stay in sync", async () => {
  const widget = await fs.readFile(new URL("../public/widget.js", import.meta.url), "utf8");
  const declared = widget.match(/^const fonts = \[(.*?)\];/mu);
  assert.ok(declared, "không tìm thấy danh sách font trong widget.js");
  const pickerFonts = [...declared[1].matchAll(/"([^"]+)"/gu)].map(match => match[1]);
  // `Courier New` được fontconfig ánh xạ sang Courier Prime nên không có mục riêng trong FONT_FILES.
  const bundled = new Set([...Object.keys(FONT_FILES), "Courier New"]);
  const missing = pickerFonts.filter(font => !bundled.has(font));
  assert.deepEqual(missing, [], `font trong studio nhưng chưa đi kèm repo: ${missing.join(", ")}`);
});

test("each font renders differently instead of silently falling back", async () => {
  const fonts = [...Object.keys(FONT_FILES).filter(family => family !== "Courier Prime"), "Courier New"];
  const digests = new Map();
  for (const font of fonts) digests.set(font, digest(await renderText(font)));
  // Trước khi đi kèm font, cả 7 lựa chọn đều rơi về DejaVu Sans nên cho ra ảnh giống hệt nhau.
  assert.equal(new Set(digests.values()).size, fonts.length,
    `một số font cho ra ảnh giống hệt nhau (đang fallback): ${[...digests].map(([font, value]) => `${font}=${value.slice(0, 8)}`).join(", ")}`);
});

test("font weight still varies within a single variable font file", async () => {
  const light = digest(await renderText("Montserrat", "Top 5 brand Việt", "400"));
  const black = digest(await renderText("Montserrat", "Top 5 brand Việt", "900"));
  assert.notEqual(light, black, "font biến thiên phải đổi nét theo font-weight");
});

// Tỉ lệ điểm ảnh khác nhau giữa hai bản render — dùng để phân biệt "cùng một dáng chữ"
// với "rơi về font khác hẳn", thay vì so bytes (tên họ font khác nhau vẫn đổi hinting đôi chút).
async function pixelDistance(first, second) {
  const buffers = await Promise.all([first, second]);
  const [a, b] = await Promise.all(buffers.map(buffer => sharp(buffer).raw().toBuffer()));
  let different = 0;
  for (let index = 0; index < a.length; index += 1) if (Math.abs(a[index] - b[index]) > 24) different += 1;
  return different / a.length;
}

test("Courier New maps to the bundled Courier Prime, not to a system font", async () => {
  const courierNew = await renderText("Courier New");
  const nearDistance = await pixelDistance(courierNew, renderText("Courier Prime"));
  const farDistance = await pixelDistance(courierNew, renderText("Roboto"));
  assert.ok(nearDistance < .01, `Courier New phải ra đúng dáng Courier Prime, lệch ${(nearDistance * 100).toFixed(2)}%`);
  assert.ok(farDistance > nearDistance * 5, "Courier New không được rơi về một font khác hẳn");
});

test("bundled fonts carry their upstream licence", async () => {
  const entries = await fs.readdir(FONT_DIRECTORY);
  const licences = entries.filter(name => name.startsWith("LICENSE-"));
  assert.ok(licences.length >= Object.keys(FONT_FILES).length, "mỗi họ font phải kèm file giấy phép");
});
