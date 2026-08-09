import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-render-parity-"));
const assetDirectory = path.join(tempDirectory, "assets");
process.env.DATABASE_PATH = path.join(tempDirectory, "parity.sqlite");
process.env.ASSET_DIRECTORY = assetDirectory;
await fs.mkdir(assetDirectory, { recursive: true });

const { db } = await import(`./db.js?parity=${Date.now()}`);
const service = await import(`./service-core.js?parity=${Date.now()}`);

after(async () => {
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

const WIDTH = 90, HEIGHT = 160;

async function writeAsset(name, buffer) {
  await fs.writeFile(path.join(assetDirectory, name), buffer);
  return { id: name, storageKey: name };
}

// Ba dải dọc bằng nhau: đỏ | lục | lam. Ảnh vuông nên khung 9:16 buộc phải cắt hai bên,
// vị trí vết cắt cho biết bản render dùng kiểu cắt nào.
async function bandedAsset(name) {
  const size = 300, raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 3, band = Math.floor(x / (size / 3));
    raw[index + band] = 255;
  }
  return writeAsset(name, await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
}

// Nửa trái đỏ đục, nửa phải trong suốt hoàn toàn — dùng để kiểm tra vùng alpha.
async function halfTransparentAsset(name) {
  const size = 300, raw = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 4;
    if (x < size / 2) { raw[index] = 255; raw[index + 3] = 255; }
  }
  return writeAsset(name, await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

async function flatAsset(name, [red, green, blue]) {
  const size = 300, raw = Buffer.alloc(size * size * 3);
  for (let index = 0; index < raw.length; index += 3) { raw[index] = red; raw[index + 1] = green; raw[index + 2] = blue; }
  return writeAsset(name, await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
}

function slideWith(asset, overrides = {}) {
  return { selectedAssetIds: [asset.id], compositionMode: "crop", textEnabled: false, textLayers: [], ...overrides };
}

async function renderPixels(slide, assets) {
  const rendered = await service.renderSlideSnapshot(slide, assets, { width: WIDTH, height: HEIGHT });
  const { data } = await sharp(rendered).raw().toBuffer({ resolveWithObject: true });
  return (x, y) => [data[(y * WIDTH + x) * 3], data[(y * WIDTH + x) * 3 + 1], data[(y * WIDTH + x) * 3 + 2]];
}

const dominant = pixel => pixel.indexOf(Math.max(...pixel));
const near = (actual, expected, tolerance = 10) => Math.abs(actual - expected) <= tolerance;

test("cover crop is centred like object-fit in the preview, not content-aware", async () => {
  const asset = await bandedAsset("bands.png");
  const pixel = await renderPixels(slideWith(asset), [asset]);
  // Khung nhìn canh giữa nên mép trái vẫn là dải đỏ và mép phải vẫn là dải lam.
  assert.equal(dominant(pixel(3, HEIGHT / 2)), 0, "mép trái phải là dải đỏ");
  assert.equal(dominant(pixel(WIDTH - 4, HEIGHT / 2)), 2, "mép phải phải là dải lam");
  assert.equal(dominant(pixel(WIDTH / 2, HEIGHT / 2)), 1, "giữa khung phải là dải lục");
});

test("zoom and focal point pan the same window the preview shows", async () => {
  const asset = await bandedAsset("bands-zoom.png");
  // Ở zoom 2× khung nhìn chỉ còn nửa bề ngang, nên trọng tâm quyết định nửa nào được giữ lại.
  const centred = await renderPixels(slideWith(asset, { cropZoom: 2, cropX: 50, cropY: 50 }), [asset]);
  assert.equal(dominant(centred(WIDTH / 2, HEIGHT / 2)), 1, "zoom quanh tâm vẫn giữ dải lục");

  const left = await renderPixels(slideWith(asset, { cropZoom: 2, cropX: 0, cropY: 50 }), [asset]);
  assert.equal(dominant(left(3, HEIGHT / 2)), 0, "cropX=0 giữ dải đỏ ở mép trái");
  assert.equal(dominant(left(WIDTH - 4, HEIGHT / 2)), 1, "cropX=0 đã trượt khỏi dải lam");

  const right = await renderPixels(slideWith(asset, { cropZoom: 2, cropX: 100, cropY: 50 }), [asset]);
  assert.equal(dominant(right(WIDTH - 4, HEIGHT / 2)), 2, "cropX=100 giữ dải lam ở mép phải");
  assert.equal(dominant(right(3, HEIGHT / 2)), 1, "cropX=100 đã trượt khỏi dải đỏ");
});

test("horizontal flip mirrors the framed image", async () => {
  const asset = await bandedAsset("bands-flip.png");
  const pixel = await renderPixels(slideWith(asset, { imageFlipH: true }), [asset]);
  assert.equal(dominant(pixel(3, HEIGHT / 2)), 2, "lật ngang đưa dải lam sang trái");
  assert.equal(dominant(pixel(WIDTH - 4, HEIGHT / 2)), 0, "lật ngang đưa dải đỏ sang phải");
});

test("contain fit letterboxes with the configured background", async () => {
  const asset = await bandedAsset("bands-contain.png");
  const pixel = await renderPixels(slideWith(asset, { imageFit: "contain", imageBackground: "#0000FF" }), [asset]);
  const [red, green, blue] = pixel(WIDTH / 2, 3);
  assert.ok(near(red, 0) && near(green, 0) && near(blue, 255), `nền viền phải là màu đã chọn, nhận ${red},${green},${blue}`);
  assert.equal(dominant(pixel(3, HEIGHT / 2)), 0, "chế độ vừa khung giữ trọn dải đỏ bên trái");
});

test("brightness and contrast use the sRGB formula of the CSS filter", async () => {
  const asset = await flatAsset("grey.png", [128, 128, 128]);
  const brighter = await renderPixels(slideWith(asset, { imageBrightness: 1.5 }), [asset]);
  const [red] = brighter(WIDTH / 2, HEIGHT / 2);
  // CSS brightness(1.5) trên sRGB: 128 × 1.5 = 192. modulate() của sharp làm trong không gian LCh nên lệch hẳn.
  assert.ok(near(red, 192), `độ sáng 1.5 phải cho ~192, nhận ${red}`);

  const darker = await renderPixels(slideWith(asset, { imageBrightness: .5 }), [asset]);
  assert.ok(near(darker(WIDTH / 2, HEIGHT / 2)[0], 64), "độ sáng 0.5 phải cho ~64");
});

test("grayscale and saturation collapse to the CSS luma weights", async () => {
  const asset = await flatAsset("red.png", [255, 0, 0]);
  const grey = await renderPixels(slideWith(asset, { imageGrayscale: 1 }), [asset]);
  const pixel = grey(WIDTH / 2, HEIGHT / 2);
  assert.ok(near(pixel[0], 54) && near(pixel[1], 54) && near(pixel[2], 54), `đỏ thuần khi đen trắng phải ra ~54, nhận ${pixel}`);

  const desaturated = await renderPixels(slideWith(asset, { imageSaturation: 0 }), [asset]);
  assert.ok(near(desaturated(WIDTH / 2, HEIGHT / 2)[0], 54), "saturate(0) phải trùng kết quả grayscale(1)");
});

test("hue rotation shifts colour the way the preview filter does", async () => {
  const asset = await flatAsset("red-hue.png", [255, 0, 0]);
  const rotated = await renderPixels(slideWith(asset, { imageHue: 120 }), [asset]);
  // hue-rotate(120deg) đưa đỏ về phía lục.
  assert.equal(dominant(rotated(WIDTH / 2, HEIGHT / 2)), 1);
});

test("grid gaps use the slide background instead of a hard-coded cream", async () => {
  const first = await bandedAsset("grid-a.png"), second = await bandedAsset("grid-b.png"), third = await bandedAsset("grid-c.png");
  const slide = { selectedAssetIds: [first.id, second.id, third.id], compositionMode: "grid", textEnabled: false, textLayers: [], imageBackground: "#0000FF" };
  const pixel = await renderPixels(slide, [first, second, third]);
  // Ba ảnh xếp lưới 2 cột nên ô thứ tư bỏ trống và phải hiện màu nền.
  const [red, green, blue] = pixel(WIDTH - 6, HEIGHT - 6);
  assert.ok(near(red, 0) && near(green, 0) && near(blue, 255), `ô lưới trống phải dùng màu nền, nhận ${red},${green},${blue}`);
});

test("transparent source pixels fall back to the slide background like the preview", async () => {
  const asset = await halfTransparentAsset("alpha.png");
  const rendered = await service.renderSlideSnapshot(
    slideWith(asset, { imageBackground: "#0000FF" }), [asset], { width: WIDTH, height: HEIGHT }
  );
  // Preview đặt màu nền dưới ảnh nên ảnh xuất ra không được còn kênh alpha.
  const metadata = await sharp(rendered).metadata();
  assert.equal(metadata.hasAlpha, false, "ảnh xuất ra không được giữ vùng trong suốt");

  const pixel = await renderPixels(slideWith(asset, { imageBackground: "#0000FF" }), [asset]);
  const [red, green, blue] = pixel(WIDTH - 6, HEIGHT / 2);
  assert.ok(near(red, 0) && near(green, 0) && near(blue, 255), `vùng trong suốt phải hiện màu nền, nhận ${red},${green},${blue}`);
  assert.equal(dominant(pixel(6, HEIGHT / 2)), 0, "phần đục vẫn giữ nguyên màu đỏ");
});

test("the background behind transparent pixels goes through the colour filter too", async () => {
  const asset = await halfTransparentAsset("alpha-filtered.png");
  // `filter` trong preview nằm trên `.canvas-bg`, tức là lọc cả màu nền của lớp đó.
  const pixel = await renderPixels(slideWith(asset, { imageBackground: "#0000FF", imageBrightness: .5 }), [asset]);
  const [, , blue] = pixel(WIDTH - 6, HEIGHT / 2);
  assert.ok(near(blue, 128), `nền sau khi giảm sáng 0.5 phải còn ~128, nhận ${blue}`);
});

test("transparent pixels inside a grid cell also use the slide background", async () => {
  const first = await halfTransparentAsset("alpha-grid-a.png"), second = await halfTransparentAsset("alpha-grid-b.png");
  const slide = { selectedAssetIds: [first.id, second.id], compositionMode: "grid", textEnabled: false, textLayers: [], imageBackground: "#0000FF" };
  const pixel = await renderPixels(slide, [first, second]);
  const [red, green, blue] = pixel(WIDTH - 6, HEIGHT / 4);
  assert.ok(near(red, 0) && near(green, 0) && near(blue, 255), `ô lưới có alpha phải hiện màu nền, nhận ${red},${green},${blue}`);
});

test("new image controls survive a design save round trip", () => {
  const project = service.createProject({ title: "Parity" });
  const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Subject", headline: "Headline", body: "Body" });
  const saved = service.updateSlideDesign({
    projectId: project.id, slideId: slide.id,
    cropX: 20, cropY: 80, cropZoom: 3.5,
    imageBrightness: 1, imageContrast: 1, imageSaturation: 1, imageBlur: 0, imageGrayscale: 0,
    imageHue: -90, imageFit: "contain", imageBackground: "#123456", imageFlipH: true, imageFlipV: false,
    frameInset: 40, frameWidth: 0, frameColor: "#FFFFFF", frameOpacity: 1, frameRadius: 0,
    textEnabled: true, overlayText: "Headline", textFont: "TikTok Sans", textSize: 72,
    textPosition: "center", textColor: "#FFFFFF", textAlign: "center", textX: 50, textY: 80, textLayers: []
  });
  const stored = saved.slides[0];
  assert.equal(stored.cropZoom, 3.5);
  assert.equal(stored.imageHue, -90);
  assert.equal(stored.imageFit, "contain");
  assert.equal(stored.imageBackground, "#123456");
  assert.equal(stored.imageFlipH, true);
  assert.equal(stored.imageFlipV, false);

  // Cập nhật lẻ không được xoá các giá trị đang có.
  const patched = service.updateSlideCrop({ projectId: project.id, slideId: slide.id, cropX: 60 });
  assert.equal(patched.slides[0].cropX, 60);
  assert.equal(patched.slides[0].imageFit, "contain");
  assert.equal(patched.slides[0].imageFlipH, true);
});
