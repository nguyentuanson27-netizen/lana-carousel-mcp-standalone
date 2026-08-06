import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lana-hardening-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(root, "lana.sqlite");
process.env.ASSET_DIRECTORY = path.join(root, "assets");
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:8787";
await fs.mkdir(process.env.ASSET_DIRECTORY, { recursive: true });

const service = await import("./service.js");
const { sql } = await import("./db.js");
const { buildVideoProps, orderedRenderableSlides, videoDimensionsForAspect } = await import("./video-jobs.js");
const { downloadRemoteAudio } = await import("./remote-media.js");
const { validateApiKeys } = await import("./config.js");
const { createProjectAccessUrl, exchangeProjectAccessToken, getProjectSession } = await import("./project-access.js");
const { summarizeCandidateBatch } = await import("./mcp-tools-carousel.js");

const defaults = slide => ({
  projectId: slide.projectId,
  slideId: slide.id,
  headline: slide.headline,
  body: slide.body,
  textEnabled: slide.textEnabled,
  overlayText: slide.overlayText,
  textFont: slide.textFont,
  textSize: slide.textSize,
  textPosition: slide.textPosition,
  textColor: slide.textColor,
  textAlign: slide.textAlign,
  textX: slide.textX,
  textY: slide.textY,
  textLayers: slide.textLayers
});

function insertAsset({ id, projectId, storageKey, sha256, createdAt = new Date().toISOString() }) {
  sql.createAsset.run({
    id, project_id: projectId, storage_key: storageKey,
    public_url: `http://127.0.0.1:8787/assets/${storageKey}`,
    mime_type: "image/webp", file_size: 10, width: 10, height: 10,
    sha256, source_image_url: `https://cdn.example.com/${storageKey}`,
    source_page_url: null, source_title: null, source_publisher: null,
    source_type: "unknown", alt_text: null, created_at: createdAt
  });
}

test("carousel and video hardening invariants", async t => {
  await t.test("empty carousel cannot be approved", () => {
    const project = service.createProject({ title: "Empty" });
    assert.throws(() => service.approveProjectContent(project.id), error => error.code === "EMPTY_PROJECT");
  });

  await t.test("content approval resets after editing or adding a slide", () => {
    const project = service.createProject({ title: "Approval" });
    const first = service.addSlide({ projectId: project.id, position: 1, subject: "One", headline: "Old", body: "Body" });
    service.approveProjectContent(project.id);
    assert.equal(service.getProject(project.id).contentStatus, "APPROVED");
    service.updateSlideContent({ ...defaults(first), headline: "New" });
    assert.equal(service.getProject(project.id).contentStatus, "PENDING");
    service.approveProjectContent(project.id);
    service.addSlide({ projectId: project.id, position: 2, subject: "Two", headline: "Second", body: "Body" });
    assert.equal(service.getProject(project.id).contentStatus, "PENDING");
  });

  await t.test("scene autosave merges partial fields and versions the same transaction", () => {
    const project = service.createProject({ title: "Autosave" });
    const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Scene", headline: "Scene", body: "Caption" });
    service.updateSlideVideo({ projectId: project.id, slideId: slide.id, settings: { caption: "Keep me", transition: "slide", textAnimation: "by-word", subtitles: true } });
    service.updateSlideVideo({ projectId: project.id, slideId: slide.id, settings: { duration: 4.5 } });
    const saved = service.getProject(project.id).slides[0].video;
    assert.equal(saved.caption, "Keep me");
    assert.equal(saved.transition, "slide");
    assert.equal(saved.textAnimation, "by-word");
    assert.equal(saved.subtitles, true);
    assert.equal(saved.duration, 4.5);
    assert.equal(service.getProjectVersions(project.id)[0].action, "update_slide_video");
  });

  await t.test("duplicate candidate insert reports zero changed rows", () => {
    const project = service.createProject({ title: "Duplicate" });
    const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Image", headline: "Image", body: "Body" });
    insertAsset({ id: "asset-duplicate", projectId: project.id, storageKey: "duplicate.webp", sha256: "hash-duplicate" });
    assert.equal(sql.addCandidate.run(slide.id, "asset-duplicate", new Date().toISOString()).changes, 1);
    assert.equal(sql.addCandidate.run(slide.id, "asset-duplicate", new Date().toISOString()).changes, 0);
    assert.equal(sql.countCandidates.get(slide.id).count, 1);
  });

  await t.test("MCP batch counts only candidates actually inserted", () => {
    const summary = summarizeCandidateBatch([
      { index: 0, asset: { candidateAdded: true } },
      { index: 1, asset: { candidateAdded: false } },
      { index: 2, asset: { candidateAdded: false } }
    ], [{ index: 3, error: "download failed" }]);
    assert.equal(summary.added, 1);
    assert.equal(summary.duplicates, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.partialSuccess, true);
    assert.equal(summary.duplicateResults.length, 2);
  });

  await t.test("clone leaves no partial project or copied orphan when a copy fails", async () => {
    const project = service.createProject({ title: "Atomic clone" });
    const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Clone", headline: "Clone", body: "Body" });
    await fs.writeFile(path.join(process.env.ASSET_DIRECTORY, "exists.webp"), Buffer.from("ok"));
    insertAsset({ id: "asset-exists", projectId: project.id, storageKey: "exists.webp", sha256: "hash-exists", createdAt: "2026-01-01T00:00:00.000Z" });
    insertAsset({ id: "asset-missing", projectId: project.id, storageKey: "missing.webp", sha256: "hash-missing", createdAt: "2026-01-01T00:00:01.000Z" });
    sql.addCandidate.run(slide.id, "asset-exists", new Date().toISOString());
    sql.addCandidate.run(slide.id, "asset-missing", new Date().toISOString());
    const beforeProjects = service.listProjects().length;
    await assert.rejects(service.cloneProject(project.id));
    assert.equal(service.listProjects().length, beforeProjects);
    assert.deepEqual((await fs.readdir(process.env.ASSET_DIRECTORY)).sort(), ["exists.webp"]);
  });

  await t.test("video preflight filters disabled and image-less scenes then follows scene order", () => {
    const project = {
      videoEnabled: true, contentStatus: "APPROVED", imageStatus: "APPROVED",
      slides: [
        { id: "a", selectedAssetId: "asset-a", imageApproved: true, video: { order: 2 } },
        { id: "b", selectedAssetId: "asset-b", imageApproved: true, video: { order: 0 } },
        { id: "c", selectedAssetId: "asset-c", imageApproved: true, video: { enabled: false, order: 1 } },
        { id: "d", selectedAssetId: null, imageApproved: false, video: { order: 3 } }
      ]
    };
    assert.deepEqual(orderedRenderableSlides(project).map(slide => slide.id), ["b", "a"]);
  });

  await t.test("square and landscape snapshots match composition while animated rich text remains separate", async () => {
    const project = service.createProject({ title: "Aspect" });
    const slide = service.addSlide({ projectId: project.id, position: 1, subject: "Aspect", headline: "Edge", body: "Body" });
    const storageKey = "aspect.webp";
    await sharp({ create: { width: 1200, height: 1200, channels: 3, background: "#8d3f3d" } }).webp().toFile(path.join(process.env.ASSET_DIRECTORY, storageKey));
    insertAsset({ id: "asset-aspect", projectId: project.id, storageKey, sha256: "hash-aspect" });
    sql.addCandidate.run(slide.id, "asset-aspect", new Date().toISOString());
    service.updateSlideContent({
      ...defaults(slide), textEnabled: true, overlayText: "Edge text", textX: 94, textY: 6,
      textLayers: [{ id: "edge", role: "headline", content: "Edge text", enabled: true, font: "Poppins", size: 72, x: 94, y: 6, color: "#FFFFFF", align: "right", styleRanges: [{ start: 0, end: 4, color: "#FFDF70", weight: "900" }] }]
    });
    service.approveProjectContent(project.id);
    service.approveSlideAssets({ projectId: project.id, slideId: slide.id, assetIds: ["asset-aspect"], mode: "crop" });
    service.updateProjectVideo({ projectId: project.id, enabled: true, settings: { aspectRatio: "square", textAnimation: "by-word", motion: "none" } });
    service.updateSlideVideo({ projectId: project.id, slideId: slide.id, settings: { layerAnimations: { edge: "typewriter" } } });

    let props = await buildVideoProps(service.getProject(project.id, { includeStorage: true }));
    let image = Buffer.from(props.scenes[0].imageUrl.split(",")[1], "base64");
    let metadata = await sharp(image).metadata();
    assert.deepEqual(videoDimensionsForAspect("square"), { width: 1080, height: 1080 });
    assert.deepEqual([metadata.width, metadata.height], [1080, 1080]);
    assert.equal(props.scenes[0].textLayers[0].animation, "typewriter");
    assert.equal(props.scenes[0].textLayers[0].x, 94);
    assert.equal(props.scenes[0].textLayers[0].y, 6);
    assert.equal(props.scenes[0].textLayers[0].styleRanges[0].weight, "900");

    service.updateProjectVideo({ projectId: project.id, enabled: true, settings: { aspectRatio: "landscape" } });
    props = await buildVideoProps(service.getProject(project.id, { includeStorage: true }));
    image = Buffer.from(props.scenes[0].imageUrl.split(",")[1], "base64");
    metadata = await sharp(image).metadata();
    assert.deepEqual(videoDimensionsForAspect("landscape"), { width: 1920, height: 1080 });
    assert.deepEqual([metadata.width, metadata.height], [1920, 1080]);
  });

  await t.test("one-time MCP project link creates a scoped session once", () => {
    const project = service.createProject({ title: "Access" });
    const url = new URL(createProjectAccessUrl(project.id));
    assert.equal(url.pathname, "/widget-auth.html");
    const accessToken = new URLSearchParams(url.hash.slice(1)).get("access_token");
    assert.ok(accessToken);
    assert.equal(url.searchParams.has("api_key"), false);
    const exchanged = exchangeProjectAccessToken(accessToken, project.id);
    assert.equal(getProjectSession(exchanged.sessionToken).project_id, project.id);
    assert.throws(() => exchangeProjectAccessToken(accessToken, project.id), error => error.code === "ACCESS_TOKEN_INVALID");
  });

  await t.test("production key validation rejects weak and placeholder secrets", () => {
    assert.throws(() => validateApiKeys([], { required: true }), /required/u);
    assert.throws(() => validateApiKeys(["too-short"]), /32 characters/u);
    assert.throws(() => validateApiKeys(["replace-with-a-long-random-secret-1234567890"]), /placeholder/u);
    assert.deepEqual(validateApiKeys(["b".repeat(64)]), ["b".repeat(64)]);
  });

  await t.test("remote audio blocks loopback before downloading", async () => {
    await assert.rejects(downloadRemoteAudio("https://127.0.0.1/private.mp3", root), error => error.code === "SSRF_BLOCKED");
  });
});
