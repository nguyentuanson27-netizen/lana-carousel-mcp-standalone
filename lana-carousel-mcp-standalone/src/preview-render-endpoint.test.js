import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-proof-"));
const assetDirectory = path.join(tempDirectory, "assets");
process.env.DATABASE_PATH = path.join(tempDirectory, "proof.sqlite");
process.env.ASSET_DIRECTORY = assetDirectory;
await fs.mkdir(assetDirectory, { recursive: true });

const { db } = await import(`./db.js?proof=${Date.now()}`);
const service = await import(`./service-core.js?proof=${Date.now()}`);

after(async () => {
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

const timestamp = new Date().toISOString();

let seedCounter = 0;

async function seed() {
  const project = service.createProject({ title: "Proof" });
  const slide = service.addSlide({ projectId: project.id, position: 1, subject: "S", headline: "Tiêu đề", body: "Nội dung" });
  // Mỗi lần gieo dùng asset riêng: bảng assets là duy nhất theo id và theo (project_id, sha256).
  seedCounter += 1;
  const assetId = `22222222-2222-4222-8222-${String(seedCounter).padStart(12, "0")}`;
  const size = 300, raw = Buffer.alloc(size * size * 3);
  for (let index = 0; index < raw.length; index += 3) { raw[index] = 200; raw[index + 1] = 40; raw[index + 2] = 40; }
  await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path.join(assetDirectory, "proof.png"));
  db.prepare(`INSERT INTO assets (id,project_id,storage_key,public_url,mime_type,file_size,width,height,sha256,source_image_url,source_type,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(assetId, project.id, "proof.png", "/assets/proof.png", "image/png", 100, size, size, `sha-proof-${seedCounter}`, "https://example.com/a.png", "unknown", timestamp);
  db.prepare("INSERT INTO slide_asset_selections (slide_id,asset_id,position) VALUES (?,?,0)").run(slide.id, assetId);
  db.prepare("UPDATE slides SET selected_asset_id=?, composition_mode='crop' WHERE id=?").run(assetId, slide.id);
  return { project, slide, assetId };
}

const meanChannel = async buffer => {
  const pixels = await sharp(buffer).raw().toBuffer();
  return pixels.reduce((total, value) => total + value, 0) / pixels.length;
};

test("renders the design that was posted, not the one stored", async () => {
  const { project, slide } = await seed();
  const stored = await service.renderSlidePreview({ projectId: project.id, slideId: slide.id, width: 90, height: 160 });
  const darkened = await service.renderSlidePreview({
    projectId: project.id, slideId: slide.id, width: 90, height: 160,
    design: { imageBrightness: .5 }
  });
  assert.ok(await meanChannel(darkened) < await meanChannel(stored) * .8, "thiết kế gửi lên phải được áp dụng");
});

test("rendering a preview never writes the design to the database", async () => {
  const { project, slide } = await seed();
  const before = service.getProject(project.id).slides[0];
  await service.renderSlidePreview({
    projectId: project.id, slideId: slide.id, width: 90, height: 160,
    design: { imageBrightness: .4, cropZoom: 3, imageFlipH: true }
  });
  const after = service.getProject(project.id).slides[0];
  assert.equal(after.imageBrightness, before.imageBrightness);
  assert.equal(after.cropZoom, before.cropZoom);
  assert.equal(after.imageFlipH, before.imageFlipH);
  assert.equal(after.designSavedAt, before.designSavedAt, "không được đụng tới trạng thái đã lưu");
});

test("only design fields are honoured; identity and selection come from the database", async () => {
  const { project, slide, assetId } = await seed();
  const rendered = await service.renderSlidePreview({
    projectId: project.id, slideId: slide.id, width: 90, height: 160,
    // Những trường này phải bị bỏ qua, nếu không client có thể render ảnh của dự án khác.
    design: { id: "khac", projectId: "khac", selectedAssetIds: ["khong-ton-tai"], imageApproved: true }
  });
  const metadata = await sharp(rendered).metadata();
  assert.equal(metadata.width, 90);
  assert.equal(service.getProject(project.id).slides[0].selectedAssetIds[0], assetId);
});

test("an unknown slide is rejected instead of rendering something else", async () => {
  const { project } = await seed();
  await assert.rejects(
    () => service.renderSlidePreview({ projectId: project.id, slideId: "33333333-3333-4333-8333-333333333333" }),
    /SLIDE_NOT_FOUND|Không tìm thấy slide/u
  );
});
