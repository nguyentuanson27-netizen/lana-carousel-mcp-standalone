import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Test này chụp khung xem trước thật trong Chromium rồi so từng điểm ảnh với bản render của server.
// Đây là lưới an toàn cho toàn bộ hợp đồng trong docs/preview-render-parity.md: các bài test khác
// chỉ kiểm tra phía server, còn bài này bắt được cả sai lệch do CSS.
// Bỏ qua khi máy không có Playwright/Chromium để `npm test` vẫn chạy được ở mọi nơi.

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-browser-parity-"));
const assetDirectory = path.join(tempDirectory, "assets");
process.env.DATABASE_PATH = path.join(tempDirectory, "browser.sqlite");
process.env.ASSET_DIRECTORY = assetDirectory;
await fs.mkdir(assetDirectory, { recursive: true });

const { db } = await import(`./db.js?browser=${Date.now()}`);
const service = await import(`./service-core.js?browser=${Date.now()}`);

const WIDTH = 540, HEIGHT = 960;
// Trang thử và ảnh thử nằm ở đây; static server tra thư mục này trước rồi mới tới public/,
// nhờ vậy không phải ghi file tạm vào cây nguồn.
const serveDirectory = path.join(tempDirectory, "serve");
await fs.mkdir(serveDirectory, { recursive: true });

after(async () => {
  db.close();
  await browser?.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

/** Ảnh nguồn nhiều chi tiết để lộ ngay sai lệch về vùng cắt. */
async function makeSource(name, size = 600) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 3;
    if (x < size / 3) { raw[index] = 205; raw[index + 1] = 45; raw[index + 2] = 45; }
    else if (x < size * 2 / 3) { raw[index] = 40; raw[index + 1] = 165; raw[index + 2] = 80; }
    else { raw[index] = 40; raw[index + 1] = 70; raw[index + 2] = 200; }
    if (y % 70 < 5) { raw[index] = 250; raw[index + 1] = 250; raw[index + 2] = 250; }
  }
  await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path.join(assetDirectory, name));
  await fs.copyFile(path.join(assetDirectory, name), path.join(serveDirectory, name));
  return { id: name, storageKey: name, publicUrl: `./${name}` };
}

/** Dựng trang preview bằng chính module mà studio dùng, nạp qua CSS thật của studio. */
function previewPage(slide, assetList) {
  return `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="./fonts.css"><link rel="stylesheet" href="./stitch-ui.css">
<style>html,body{margin:0;background:#000}
.canvas{width:${WIDTH}px!important;height:${HEIGHT}px!important;border-radius:0!important;box-shadow:none!important}</style>
<div id="stage"></div>
<script type="module">
import { background, layerHtml, imageDefaults, withTextBox } from "./preview-dom.js";
const slide = ${JSON.stringify(slide)};
const assets = new Map(${JSON.stringify(assetList.map(asset => [asset.id, { publicUrl: asset.publicUrl }]))});
const data = { ...imageDefaults(slide), layers: (slide.textLayers || []).map(withTextBox) };
document.getElementById("stage").innerHTML =
  '<div class="canvas">' + background(slide, data, assets) +
  data.layers.map((layer, index) => layerHtml(layer, index, false)).join("") + '</div>';
await document.fonts.ready;
await Promise.all([...document.images].map(image => image.complete ? null : image.decode().catch(() => null)));
document.body.dataset.ready = "1";
</script>`;
}

const CONTENT_TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf" };

/** Static server tối giản: module ES không nạp được qua file:// vì chính sách CORS của trình duyệt. */
function startStaticServer() {
  const server = http.createServer(async (request, response) => {
    const name = path.basename(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    for (const directory of [serveDirectory, publicDirectory]) {
      try {
        const body = await fs.readFile(path.join(directory, name));
        response.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(name)] || "application/octet-stream" });
        return response.end(body);
      } catch { /* thử thư mục tiếp theo */ }
    }
    response.writeHead(404).end("not found");
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function compare(browser, origin, slide, assetList) {
  const pageName = `preview-${Date.now()}-${Math.random().toString(36).slice(2)}.html`;
  await fs.writeFile(path.join(serveDirectory, pageName), previewPage(slide, assetList));
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") pageErrors.push(message.text()); });
  await page.goto(`${origin}/${pageName}`);
  await page.waitForSelector("body[data-ready='1']", { timeout: 15000 })
    .catch(error => { throw new Error(`preview không dựng được: ${pageErrors.join(" | ") || error.message}`); });
  const shot = await page.locator(".canvas").screenshot();
  await page.close();

  const rendered = await service.renderSlideSnapshot(slide, assetList, { width: WIDTH, height: HEIGHT });
  const [browserPixels, serverPixels] = await Promise.all([
    sharp(shot).removeAlpha().raw().toBuffer(),
    sharp(rendered).removeAlpha().raw().toBuffer()
  ]);
  let total = 0, offCount = 0;
  for (let index = 0; index < serverPixels.length; index += 1) {
    const delta = Math.abs(serverPixels[index] - browserPixels[index]);
    total += delta;
    if (delta > 32) offCount += 1;
  }
  return { meanDelta: total / serverPixels.length, offRatio: offCount / serverPixels.length };
}

let browser = null, skipReason = chromium ? false : "chưa cài playwright";
if (chromium) {
  const executablePath = process.env.CHROMIUM_PATH;
  try { browser = await chromium.launch(executablePath ? { executablePath } : {}); }
  catch (error) { skipReason = `không mở được Chromium: ${error.message.split("\n")[0]}`; }
}

describe("preview and download stay pixel-comparable", { skip: skipReason }, () => {
  let asset, secondAsset, staticServer, origin;

  before(async () => {
    const started = await startStaticServer();
    staticServer = started.server;
    origin = `http://127.0.0.1:${started.port}`;
    asset = await makeSource("__parity-a.png");
    secondAsset = await makeSource("__parity-b.png", 500);
  });

  after(async () => {
    await new Promise(resolve => staticServer ? staticServer.close(resolve) : resolve());
  });

  const baseSlide = overrides => ({
    selectedAssetIds: ["__parity-a.png"], compositionMode: "crop", textEnabled: false, textLayers: [],
    cropX: 50, cropY: 50, cropZoom: 1, imageFit: "cover", imageBackground: "#181411",
    imageBrightness: 1, imageContrast: 1, imageSaturation: 1, imageGrayscale: 0, imageHue: 0, imageBlur: 0,
    imageFlipH: false, imageFlipV: false, frameWidth: 0, ...overrides
  });

  const cases = [
    ["ảnh đơn, mặc định", {}],
    ["zoom và trọng tâm lệch", { cropZoom: 1.8, cropX: 30, cropY: 65 }],
    ["chỉnh màu đầy đủ", { imageBrightness: 1.25, imageContrast: 1.15, imageSaturation: .8, imageGrayscale: .15, imageHue: 40 }],
    ["lật ngang và dọc", { imageFlipH: true, imageFlipV: true, cropZoom: 1.4 }],
    ["vừa cả ảnh với nền màu", { imageFit: "contain", imageBackground: "#204060" }],
    ["khung viền bo góc", { frameWidth: 18, frameInset: 40, frameColor: "#FFD166", frameOpacity: 1, frameRadius: 60 }]
  ];

  for (const [name, overrides] of cases) {
    test(name, async () => {
      const { meanDelta, offRatio } = await compare(browser, origin, baseSlide(overrides), [asset]);
      assert.ok(meanDelta < 4, `lệch trung bình ${meanDelta.toFixed(2)}/255 (ngưỡng 4)`);
      assert.ok(offRatio < .04, `${(offRatio * 100).toFixed(2)}% kênh lệch quá 32 (ngưỡng 4%)`);
    });
  }

  // Chữ lệch nhiều hơn ảnh vì trình duyệt và librsvg khử răng cưa khác nhau, nên ngưỡng nới rộng hơn.
  // Mục tiêu ở đây là bắt sai lệch về vị trí, cỡ chữ, font và điểm ngắt dòng.
  const textLayer = overrides => ({
    id: "h", role: "headline", enabled: true, content: "Top 5 brand Việt mua mà thấy đáng tiền",
    font: "Playfair Display", size: 72, weight: "700", x: 50, y: 40, color: "#FFFFFF", align: "center",
    opacity: 1, rotation: 0, ...overrides
  });

  const textCases = [
    ["chữ không hộp", [textLayer({})]],
    ["chữ trong hộp", [textLayer({ boxEnabled: true, boxColor: "#FFFFFF", boxOpacity: .92, boxBorderColor: "#8D3F3D", boxBorderWidth: 6, boxRadius: 28, boxPaddingX: 36, boxPaddingY: 22, boxWidth: 78, color: "#111111" })]],
    ["hai lớp chữ khác font", [textLayer({ font: "Bebas Neue", size: 96, y: 30 }), textLayer({ id: "b", role: "body", font: "Montserrat", size: 44, y: 70, content: "Áo khoác dạ, chân váy tweed và nhiều hơn nữa" })]]
  ];

  for (const [name, layers] of textCases) {
    test(name, async () => {
      const slide = baseSlide({ textEnabled: true, textLayers: layers });
      const { meanDelta, offRatio } = await compare(browser, origin, slide, [asset]);
      assert.ok(meanDelta < 9, `lệch trung bình ${meanDelta.toFixed(2)}/255 (ngưỡng 9)`);
      assert.ok(offRatio < .09, `${(offRatio * 100).toFixed(2)}% kênh lệch quá 32 (ngưỡng 9%)`);
    });
  }

  test("lưới nhiều ảnh", async () => {
    const slide = baseSlide({ selectedAssetIds: ["__parity-a.png", "__parity-b.png"], compositionMode: "grid" });
    const { meanDelta, offRatio } = await compare(browser, origin, slide, [asset, secondAsset]);
    assert.ok(meanDelta < 4, `lệch trung bình ${meanDelta.toFixed(2)}/255`);
    assert.ok(offRatio < .04, `${(offRatio * 100).toFixed(2)}% kênh lệch quá 32`);
  });
});
