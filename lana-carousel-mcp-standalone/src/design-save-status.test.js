import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-design-save-"));
process.env.DATABASE_PATH = path.join(tempDirectory, "design-save.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempDirectory, "assets");

const { db, sql } = await import(`./db.js?design-save=${Date.now()}`);
const service = await import(`./service-core.js?design-save=${Date.now()}`);

after(async () => {
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

test("saving slide design persists completion without resetting approvals", () => {
  const project = service.createProject({ title: "Design save" });
  const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Subject", headline: "Headline", body: "Body" });
  const timestamp = new Date().toISOString();
  sql.approveContent.run(timestamp, project.id);
  sql.approveImages.run(timestamp, project.id);
  db.prepare("UPDATE slides SET image_approved=1 WHERE id=?").run(slide.id);

  const saved = service.updateSlideDesign({
    projectId: project.id, slideId: slide.id,
    cropX: 50, cropY: 50, cropZoom: 1,
    imageBrightness: 1, imageContrast: 1, imageSaturation: 1, imageBlur: 0, imageGrayscale: 0,
    frameInset: 40, frameWidth: 0, frameColor: "#FFFFFF", frameOpacity: 1, frameRadius: 0,
    textEnabled: true, overlayText: "Headline", textFont: "TikTok Sans", textSize: 72,
    textPosition: "center", textColor: "#FFFFFF", textAlign: "center", textX: 50, textY: 80,
    textLayers: [{ id: "headline", role: "headline", content: "Headline", enabled: true, font: "TikTok Sans", size: 72, x: 50, y: 80, color: "#FFFFFF", align: "center", opacity: 1, rotation: 0 }]
  });

  assert.equal(saved.contentStatus, "APPROVED");
  assert.equal(saved.imageStatus, "APPROVED");
  assert.equal(saved.slides[0].imageApproved, true);
  assert.equal(saved.slides[0].designSaved, true);
  assert.ok(saved.slides[0].designSavedAt);

  const afterContentChange = service.updateSlideContent({
    projectId: project.id, slideId: slide.id, headline: "Headline", body: "Body changed",
    textEnabled: true, overlayText: "Headline", textFont: "TikTok Sans", textSize: 72,
    textPosition: "center", textColor: "#FFFFFF", textAlign: "center", textX: 50, textY: 80,
    textLayers: saved.slides[0].textLayers
  });
  assert.equal(afterContentChange.contentStatus, "PENDING");
  assert.equal(afterContentChange.slides[0].designSaved, false);
});

test("Carousel UI reads persisted design save state", async () => {
  const widget = await fs.readFile(new URL("../public/widget.js", import.meta.url), "utf8");
  const stitch = await fs.readFile(new URL("../public/stitch-ui.js", import.meta.url), "utf8");
  assert.match(widget, /data-design-saved=/u);
  assert.match(widget, /slides\/\$\{slideId\}\/design/u);
  assert.match(stitch, /card\.dataset\.designSaved === 'true' \? 'done' : 'pending'/u);
  assert.match(stitch, /Đã lưu thiết kế/u);
});
