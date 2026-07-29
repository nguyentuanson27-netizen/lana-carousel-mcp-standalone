import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db, sql } from "./db.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { importAndStoreImage } from "./image-importer.js";

const now = () => new Date().toISOString();
const bool = value => Boolean(value);
const PROJECT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function mapSlide(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, position: row.position, subject: row.subject,
    headline: row.headline, body: row.body, selectedAssetId: row.selected_asset_id,
    selectedAssetIds: sql.getSelections.all(row.id).map(item => item.asset_id),
    candidateAssetIds: sql.getCandidates.all(row.id).map(item => item.asset_id),
    compositionMode: row.composition_mode || "crop", isLocked: bool(row.is_locked),
    imageApproved: bool(row.image_approved), renderStatus: row.render_status,
    textEnabled: bool(row.text_enabled), overlayText: row.overlay_text ?? row.headline,
    textFont: row.text_font || "TikTok Sans", textSize: row.text_size || 72,
    textPosition: row.text_position || "bottom", textColor: row.text_color || "#FFFFFF",
    textAlign: row.text_align || "center", textX: row.text_x ?? 50, textY: row.text_y ?? 80,
    cropX: row.crop_x ?? 50, cropY: row.crop_y ?? 50, cropZoom: row.crop_zoom ?? 1,
    imageBrightness: row.image_brightness ?? 1, imageContrast: row.image_contrast ?? 1,
    imageSaturation: row.image_saturation ?? 1, imageBlur: row.image_blur ?? 0,
    imageGrayscale: row.image_grayscale ?? 0, frameInset: row.frame_inset ?? 40,
    frameWidth: row.frame_width ?? 0, frameColor: row.frame_color || "#FFFFFF",
    frameOpacity: row.frame_opacity ?? 1, frameRadius: row.frame_radius ?? 0,
    textLayers: (() => { try { return JSON.parse(row.text_layers || "[]"); } catch { return []; } })()
  };
}

function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id, projectId: row.project_id, publicUrl: row.public_url, mimeType: row.mime_type,
    fileSize: row.file_size, width: row.width, height: row.height, sha256: row.sha256,
    sourceImageUrl: row.source_image_url, sourcePageUrl: row.source_page_url,
    sourceTitle: row.source_title, sourcePublisher: row.source_publisher,
    sourceType: row.source_type, altText: row.alt_text
  };
}

export function createProject({ title, topic = "", slideLimit = 10 }) {
  const id = randomUUID();
  const createdAt = now();
  sql.createProject.run({ id, title, topic, slide_limit: slideLimit, created_at: createdAt, expires_at: new Date(Date.now() + PROJECT_TTL_MS).toISOString() });
  return getProject(id);
}

export function addSlide({ projectId, position, subject, headline, body }) {
  const guardProject = sql.getProject.get(projectId);
  if (guardProject && sql.countSlides.get(projectId).count >= (guardProject.slide_limit || 10)) {
    throw new AppError("SLIDE_LIMIT_REACHED", `Dự án chỉ cho phép tối đa ${guardProject.slide_limit || 10} slide. Ảnh ứng viên phải được thêm bằng add_image_candidate.`, 409);
  }
  if (guardProject && sql.getSlideBySubject.get(projectId, subject)) {
    throw new AppError("DUPLICATE_SLIDE_SUBJECT", "Mỗi chủ đề chỉ được tạo một slide. Hãy dùng add_image_candidate để thêm ảnh vào slide hiện có.", 409);
  }
  if (/(?:ảnh|image|photo)\s*\d+\s*\/\s*\d+/iu.test(headline) || /(?:ảnh|image|photo)\s*\d+\s*\/\s*\d+/iu.test(subject)) {
    throw new AppError("IMAGE_VARIANT_IS_NOT_A_SLIDE", "Không được tạo slide riêng cho từng phương án ảnh. Hãy tạo một slide nội dung rồi dùng add_image_candidate.", 409);
  }
  if (!sql.getProject.get(projectId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  const id = randomUUID(), timestamp = now();
  try {
    sql.createSlide.run({ id, project_id: projectId, position, subject, headline, body, created_at: timestamp, updated_at: timestamp });
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new AppError("SLIDE_POSITION_EXISTS", "Vị trí slide đã tồn tại.", 409);
    throw error;
  }
  return mapSlide(sql.getSlide.get(id));
}

export function getProject(projectId) {
  const project = sql.getProject.get(projectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  return {
    id: project.id, title: project.title, topic: project.topic,
    widgetUrl: `${config.publicBaseUrl}/widget?projectId=${encodeURIComponent(project.id)}`,
    contentStatus: project.content_status || "PENDING", imageStatus: project.image_status || "PENDING", slideLimit: project.slide_limit || 10,
    createdAt: project.created_at, updatedAt: project.updated_at, expiresAt: project.expires_at,
    brandKit: { font: project.brand_font || "TikTok Sans", color: project.brand_color || "#FFFFFF" },
    slides: sql.getSlides.all(projectId).map(mapSlide), assets: sql.getAssets.all(projectId).map(mapAsset)
  };
}

function saveVersion(projectId, action) {
  const snapshot = getProject(projectId);
  sql.createVersion.run(randomUUID(), projectId, action, JSON.stringify(snapshot), now());
}

export function listProjects({ search = "" } = {}) {
  const query = search.trim().toLocaleLowerCase("vi");
  return sql.listProjects.all().filter(row => !query || `${row.title} ${row.topic}`.toLocaleLowerCase("vi").includes(query)).map(row => ({
    id: row.id, title: row.title, topic: row.topic, contentStatus: row.content_status,
    imageStatus: row.image_status, createdAt: row.created_at, updatedAt: row.updated_at,
    expiresAt: row.expires_at, widgetUrl: `${config.publicBaseUrl}/widget?projectId=${encodeURIComponent(row.id)}`
  }));
}

export async function deleteProject(projectId) {
  const project = sql.getProject.get(projectId);
  if (!project) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  const files = sql.getProjectAssetFiles.all(projectId);
  sql.deleteProject.run(projectId);
  for (const { storage_key: storageKey } of files) {
    if (path.basename(storageKey) === storageKey) await fs.unlink(path.join(config.assetDirectory, storageKey)).catch(() => undefined);
  }
  return { success: true, projectId, deletedAssets: files.length };
}

export async function cloneProject(projectId) {
  const source = getProject(projectId);
  const clone = createProject({ title: `${source.title} (bản sao)`, topic: source.topic, slideLimit: source.slideLimit });
  const slideMap = new Map();
  for (const slide of source.slides) {
    const created = addSlide({ projectId: clone.id, position: slide.position, subject: slide.subject, headline: slide.headline, body: slide.body });
    slideMap.set(slide.id, created.id);
  }
  const assetMap = new Map();
  for (const asset of sql.getAssets.all(projectId)) {
    const extension = path.extname(asset.storage_key) || ".webp", storageKey = `${randomUUID()}${extension}`;
    await fs.copyFile(path.join(config.assetDirectory, asset.storage_key), path.join(config.assetDirectory, storageKey));
    const id = randomUUID();
    sql.createAsset.run({ ...asset, id, project_id: clone.id, storage_key: storageKey, public_url: `${config.publicBaseUrl}/assets/${storageKey}`, created_at: now() });
    assetMap.set(asset.id, id);
  }
  for (const slide of source.slides) {
    const newSlideId = slideMap.get(slide.id);
    for (const oldAssetId of slide.candidateAssetIds) sql.addCandidate.run(newSlideId, assetMap.get(oldAssetId), now());
    if (slide.selectedAssetId) {
      const ids = (slide.selectedAssetIds.length ? slide.selectedAssetIds : [slide.selectedAssetId]).map(id => assetMap.get(id));
      db.transaction(() => {
        sql.clearSelections.run(newSlideId); ids.forEach((id, index) => sql.addSelection.run(newSlideId, id, index));
        sql.approveSlideAsset.run(ids[0], slide.compositionMode, now(), newSlideId);
      })();
    }
    updateSlideCrop({
      projectId: clone.id, slideId: newSlideId, cropX: slide.cropX, cropY: slide.cropY, cropZoom: slide.cropZoom,
      imageBrightness: slide.imageBrightness, imageContrast: slide.imageContrast,
      imageSaturation: slide.imageSaturation, imageBlur: slide.imageBlur,
      imageGrayscale: slide.imageGrayscale, frameInset: slide.frameInset,
      frameWidth: slide.frameWidth, frameColor: slide.frameColor,
      frameOpacity: slide.frameOpacity, frameRadius: slide.frameRadius
    });
    updateSlideContent({ projectId: clone.id, slideId: newSlideId, headline: slide.headline, body: slide.body,
      textEnabled: slide.textEnabled, overlayText: slide.overlayText, textFont: slide.textFont, textSize: slide.textSize,
      textPosition: slide.textPosition, textColor: slide.textColor, textAlign: slide.textAlign,
      textX: slide.textX, textY: slide.textY, textLayers: slide.textLayers });
  }
  updateBrandKit({ projectId: clone.id, font: source.brandKit.font, color: source.brandKit.color, applyToAll: false });
  if (source.contentStatus === "APPROVED") sql.approveContent.run(clone.id);
  if (source.imageStatus === "APPROVED") sql.approveImages.run(clone.id);
  saveVersion(clone.id, "clone_project");
  return getProject(clone.id);
}

export function extendProject(projectId, days = 14) {
  if (!sql.getProject.get(projectId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  sql.extendProject.run(days, now(), projectId);
  saveVersion(projectId, `extend_${days}_days`);
  return getProject(projectId);
}

export function updateBrandKit({ projectId, font, color, applyToAll = false }) {
  if (!sql.getProject.get(projectId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  sql.updateBrandKit.run(font, color, now(), projectId);
  if (applyToAll) {
    for (const slide of sql.getSlides.all(projectId).map(mapSlide)) {
      sql.updateSlideContent.run({
        id: slide.id, project_id: projectId, headline: slide.headline, body: slide.body,
        text_enabled: slide.textEnabled ? 1 : 0, overlay_text: slide.overlayText,
        text_font: font, text_size: slide.textSize, text_position: slide.textPosition,
        text_color: color, text_align: slide.textAlign, text_x: slide.textX, text_y: slide.textY,
        text_layers: JSON.stringify((slide.textLayers || []).map(layer => ({ ...layer, font, color }))), updated_at: now()
      });
    }
  }
  saveVersion(projectId, "update_brand_kit");
  return getProject(projectId);
}

export function updateSlideCrop(input) {
  const row = sql.getSlide.get(input.slideId);
  if (!row || row.project_id !== input.projectId) throw new AppError("SLIDE_NOT_FOUND", "Không tìm thấy slide.", 404);
  const slide = mapSlide(row);
  sql.updateSlideCrop.run({
    id: input.slideId,
    project_id: input.projectId,
    crop_x: input.cropX ?? slide.cropX,
    crop_y: input.cropY ?? slide.cropY,
    crop_zoom: input.cropZoom ?? slide.cropZoom,
    image_brightness: input.imageBrightness ?? slide.imageBrightness,
    image_contrast: input.imageContrast ?? slide.imageContrast,
    image_saturation: input.imageSaturation ?? slide.imageSaturation,
    image_blur: input.imageBlur ?? slide.imageBlur,
    image_grayscale: input.imageGrayscale ?? slide.imageGrayscale,
    frame_inset: input.frameInset ?? slide.frameInset,
    frame_width: input.frameWidth ?? slide.frameWidth,
    frame_color: input.frameColor ?? slide.frameColor,
    frame_opacity: input.frameOpacity ?? slide.frameOpacity,
    frame_radius: input.frameRadius ?? slide.frameRadius,
    updated_at: now()
  });
  saveVersion(input.projectId, "update_image_design");
  return getProject(input.projectId);

}

export function getProjectVersions(projectId) {
  if (!sql.getProject.get(projectId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  return sql.getVersions.all(projectId).map(row => ({ id: row.id, action: row.action, createdAt: row.created_at }));
}

export function restoreProjectVersion(projectId, versionId) {
  const row = sql.getVersion.get(versionId, projectId);
  if (!row) throw new AppError("VERSION_NOT_FOUND", "Không tìm thấy phiên bản.", 404);
  const snapshot = JSON.parse(row.snapshot);
  for (const oldSlide of snapshot.slides || []) {
    if (!sql.getSlide.get(oldSlide.id)) continue;
    sql.updateSlideCrop.run({
      id: oldSlide.id, project_id: projectId,
      crop_x: oldSlide.cropX ?? 50, crop_y: oldSlide.cropY ?? 50, crop_zoom: oldSlide.cropZoom ?? 1,
      image_brightness: oldSlide.imageBrightness ?? 1, image_contrast: oldSlide.imageContrast ?? 1,
      image_saturation: oldSlide.imageSaturation ?? 1, image_blur: oldSlide.imageBlur ?? 0,
      image_grayscale: oldSlide.imageGrayscale ?? 0, frame_inset: oldSlide.frameInset ?? 40,
      frame_width: oldSlide.frameWidth ?? 0, frame_color: oldSlide.frameColor || "#FFFFFF",
      frame_opacity: oldSlide.frameOpacity ?? 1, frame_radius: oldSlide.frameRadius ?? 0,
      updated_at: now()
    });
    sql.updateSlideContent.run({ id: oldSlide.id, project_id: projectId, headline: oldSlide.headline, body: oldSlide.body,
      text_enabled: oldSlide.textEnabled ? 1 : 0, overlay_text: oldSlide.overlayText, text_font: oldSlide.textFont,
      text_size: oldSlide.textSize, text_position: oldSlide.textPosition, text_color: oldSlide.textColor,
      text_align: oldSlide.textAlign, text_x: oldSlide.textX, text_y: oldSlide.textY,
      text_layers: JSON.stringify(oldSlide.textLayers || []), updated_at: now() });
  }
  sql.updateProjectStatuses.run(snapshot.contentStatus || "PENDING", snapshot.imageStatus || "PENDING", now(), projectId);
  saveVersion(projectId, `restore_${versionId}`);
  return getProject(projectId);
}

export async function purgeExpiredProjects() {
  const expired = sql.getExpiredProjects.all();
  const removed = [];
  for (const project of expired) {
    const files = sql.getProjectAssetFiles.all(project.id);
    for (const { storage_key: storageKey } of files) {
      if (path.basename(storageKey) !== storageKey) continue;
      await fs.unlink(path.join(config.assetDirectory, storageKey)).catch(error => {
        if (error?.code !== "ENOENT") console.error("Cannot remove expired asset", storageKey, error);
      });
    }
    sql.deleteProject.run(project.id);
    removed.push({ id: project.id, title: project.title, assets: files.length });
  }
  if (removed.length) console.log("Expired projects removed", JSON.stringify(removed));
  return removed;
}

export async function importAssetFromUrl(input) {
  const slideRow = sql.getSlide.get(input.slideId);
  if (!slideRow) throw new AppError("SLIDE_NOT_FOUND", "Không tìm thấy slide.", 404);
  const slide = mapSlide(slideRow);
  if (slide.projectId !== input.projectId) throw new AppError("SLIDE_PROJECT_MISMATCH", "Slide không thuộc dự án.");
  if (slide.isLocked) throw new AppError("SLIDE_LOCKED", "Slide đang bị khóa.", 409);
  if (sql.countCandidates.get(input.slideId).count >= 10) throw new AppError("CANDIDATE_LIMIT_REACHED", "Mỗi slide chỉ được gắn tối đa 10 ảnh ứng viên.", 409);
  if (input.selectAsset !== false && slide.selectedAssetId && !input.forceReplace) throw new AppError("SLIDE_ALREADY_HAS_ASSET", "Slide đã có ảnh.", 409);

  const stored = await importAndStoreImage({ imageUrl: input.imageUrl, sourcePageUrl: input.sourcePageUrl });
  let assetRow = sql.findAssetByHash.get(input.projectId, stored.sha256);
  const reused = Boolean(assetRow);
  if (assetRow) await fs.unlink(stored.absolutePath).catch(() => undefined);
  else {
    const assetId = randomUUID(), createdAt = now();
    try {
      db.transaction(() => {
        sql.createAsset.run({ id: assetId, project_id: input.projectId, storage_key: stored.storageKey, public_url: stored.publicUrl,
          mime_type: stored.mimeType, file_size: stored.fileSize, width: stored.width, height: stored.height, sha256: stored.sha256,
          source_image_url: stored.finalUrl, source_page_url: input.sourcePageUrl || null, source_title: input.sourceTitle || null,
          source_publisher: input.sourcePublisher || null, source_type: input.sourceType || "unknown", alt_text: input.altText || null,
          created_at: createdAt });
        sql.addCandidate.run(input.slideId, assetId, createdAt);
        if (input.selectAsset !== false) sql.assignAsset.run(assetId, createdAt, input.slideId);
      })();
    } catch (error) { await fs.unlink(stored.absolutePath).catch(() => undefined); throw error; }
    assetRow = sql.getAsset.get(assetId);
  }
  if (reused) {
    const timestamp = now();
    sql.addCandidate.run(input.slideId, assetRow.id, timestamp);
    if (input.selectAsset !== false) sql.assignAsset.run(assetRow.id, timestamp, input.slideId);
  }
  sql.markImagesPending.run(input.projectId); sql.markSlideImagePending.run(input.slideId);
  return { success: true, projectId: input.projectId, slideId: input.slideId, asset: mapAsset(assetRow),
    selectedAssetId: input.selectAsset === false ? slide.selectedAssetId : assetRow.id,
    candidateCount: sql.countCandidates.get(input.slideId).count, candidateLimit: 10,
    reusedExistingAsset: reused, renderRequired: true };
}

export function approveProjectContent(projectId) {
  if (!sql.getProject.get(projectId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  sql.approveContent.run(projectId); saveVersion(projectId, "approve_content"); return getProject(projectId);
}

export function approveSlideAssets({ projectId, slideId, assetIds, mode = "crop" }) {
  const slide = sql.getSlide.get(slideId);
  if (!slide || slide.project_id !== projectId) throw new AppError("SLIDE_NOT_FOUND", "Không tìm thấy slide.", 404);
  const uniqueIds = [...new Set(assetIds || [])];
  if (uniqueIds.length < 1 || uniqueIds.length > 10) throw new AppError("INVALID_SELECTION", "Hãy chọn từ 1 đến 10 ảnh.", 400);
  if (mode === "crop" && uniqueIds.length !== 1) throw new AppError("CROP_REQUIRES_ONE_IMAGE", "Chế độ crop 9:16 chỉ dùng một ảnh.", 400);
  const candidates = new Set(sql.getCandidates.all(slideId).map(row => row.asset_id));
  for (const assetId of uniqueIds) {
    const asset = sql.getAsset.get(assetId);
    if (!asset || asset.project_id !== projectId) throw new AppError("ASSET_NOT_FOUND", "Không tìm thấy ảnh.", 404);
    if (!candidates.has(assetId)) throw new AppError("ASSET_NOT_CANDIDATE", "Ảnh không thuộc danh sách ứng viên.", 409);
  }
  db.transaction(() => {
    sql.clearSelections.run(slideId);
    uniqueIds.forEach((assetId, index) => sql.addSelection.run(slideId, assetId, index));
    sql.approveSlideAsset.run(uniqueIds[0], mode, now(), slideId);
  })();
  const project = getProject(projectId);
  if (project.slides.every(item => item.imageApproved)) sql.approveImages.run(projectId);
  saveVersion(projectId, "approve_images");
  return getProject(projectId);
}

export function approveSlideAsset({ projectId, slideId, assetId }) {
  return approveSlideAssets({ projectId, slideId, assetIds: [assetId], mode: "crop" });
}

export function updateSlideContent(input) {
  const slide = sql.getSlide.get(input.slideId);
  if (!slide || slide.project_id !== input.projectId) throw new AppError("SLIDE_NOT_FOUND", "Không tìm thấy slide.", 404);
  sql.updateSlideContent.run({
    id: input.slideId, project_id: input.projectId, headline: input.headline, body: input.body,
    text_enabled: input.textEnabled ? 1 : 0, overlay_text: input.overlayText || input.headline,
    text_font: input.textFont, text_size: input.textSize, text_position: input.textPosition,
    text_color: input.textColor, text_align: input.textAlign, text_x: input.textX,
    text_y: input.textY, text_layers: JSON.stringify(input.textLayers || []), updated_at: now()
  });
  saveVersion(input.projectId, "update_slide_content");
  return getProject(input.projectId);
}

const xmlEscape = value => String(value).replace(/[<>&"']/g, character => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);

function layerTextSvg(layer, width, height) {
  if (layer.enabled === false || !layer.content?.trim()) return "";
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const baseSize = Math.max(24, Math.min(220, number(layer.size, 72)));
  const content = String(layer.content || "");
  const legacyRanges = (layer.sizeRanges || []).map(range => ({ ...range, size:range.size }));
  const ranges = [...legacyRanges, ...(layer.styleRanges || [])].map(range => ({
    start: Math.max(0, Math.min(content.length, Math.round(number(range.start, 0)))),
    end: Math.max(0, Math.min(content.length, Math.round(number(range.end, 0)))),
    ...(range.size == null ? {} : { size:Math.max(24, Math.min(220, number(range.size, baseSize))) }),
    ...(range.font ? { font:String(range.font).slice(0,100) } : {}),
    ...(range.weight ? { weight:["400","500","600","700","800","900"].includes(String(range.weight)) ? String(range.weight) : "700" } : {}),
    ...(range.underline == null ? {} : { underline:Boolean(range.underline) })
  })).filter(range => range.end > range.start);
  const styleAt = index => {
    const style = { size:baseSize, font:String(layer.font || "TikTok Sans"), weight:String(layer.weight || "700"), underline:Boolean(layer.underline) };
    for (const range of ranges) if (index >= range.start && index < range.end) Object.assign(style, range);
    return style;
  };
  const boxEnabled = layer.boxEnabled === true;
  const boxWidth = width * Math.max(20, Math.min(96, number(layer.boxWidth, 80))) / 100;
  const paddingX = Math.max(0, Math.min(120, number(layer.boxPaddingX, 32)));
  const paddingY = Math.max(0, Math.min(80, number(layer.boxPaddingY, 20)));
  const availableWidth = boxEnabled ? Math.max(baseSize * 4, boxWidth - paddingX * 2) : 820;
  const lines = [], tokens = [...content.matchAll(/\n|[^\S\n]+|[^\s\n]+/gu)];
  let line = [], lineWidth = 0;
  const charWidth = (character, size) => size * (/\s/u.test(character) ? 0.32 : 0.55);
  const pushLine = () => {
    while (line.length && /\s/u.test(line[line.length-1].character)) line.pop();
    lines.push(line); line = []; lineWidth = 0;
  };
  const addCharacters = entries => {
    for (const entry of entries) {
      if (line.length && lineWidth + entry.width > availableWidth) pushLine();
      if (!line.length && /\s/u.test(entry.character)) continue;
      line.push(entry); lineWidth += entry.width;
    }
  };
  for (const match of tokens) {
    if (match[0] === "\n") { pushLine(); continue; }
    const entries = [];
    let characterIndex = match.index;
    for (const character of match[0]) {
      const style = styleAt(characterIndex);
      entries.push({ character, ...style, width:charWidth(character,style.size) });
      characterIndex += character.length;
    }
    const tokenWidth = entries.reduce((sum, entry) => sum + entry.width, 0);
    if (line.length && lineWidth + tokenWidth > availableWidth && tokenWidth <= availableWidth) pushLine();
    addCharacters(entries);
  }
  if (line.length || !lines.length) pushLine();
  const preparedLines = lines.map(entries => {
    const maxSize = entries.reduce((maximum, entry) => Math.max(maximum, entry.size), baseSize);
    const segments = [];
    for (const entry of entries) {
      const previous = segments[segments.length-1];
      if (previous?.size === entry.size && previous?.font === entry.font && previous?.weight === entry.weight && previous?.underline === entry.underline) previous.text += entry.character;
      else segments.push({ text:entry.character, size:entry.size, font:entry.font, weight:entry.weight, underline:entry.underline });
    }
    return { maxSize, height:Math.round(maxSize*1.18), segments };
  });
  const textHeight = preparedLines.reduce((sum, item) => sum + item.height, 0);
  const centerX = Math.round(width * Math.max(3, Math.min(97, number(layer.x, 50))) / 100);
  const centerY = Math.round(height * Math.max(3, Math.min(97, number(layer.y, 80))) / 100);
  const boxHeight = textHeight + paddingY * 2;
  const boxLeft = centerX - boxWidth / 2, boxTop = centerY - boxHeight / 2;
  const textTop = boxEnabled ? boxTop + paddingY : centerY - textHeight / 2;
  const anchor = layer.align === "left" ? "start" : layer.align === "right" ? "end" : "middle";
  const x = boxEnabled ? (layer.align === "left" ? boxLeft + paddingX : layer.align === "right" ? boxLeft + boxWidth - paddingX : centerX) : centerX;
  const font = xmlEscape(layer.font || "TikTok Sans");
  const color = /^#[0-9a-f]{6}$/iu.test(layer.color) ? layer.color : "#FFFFFF";
  const opacity = Math.max(0.1, Math.min(1, number(layer.opacity, 1)));
  const rotation = Math.max(-180, Math.min(180, number(layer.rotation, 0)));
  let box = "";
  if (boxEnabled) {
    const boxColor = /^#[0-9a-f]{6}$/iu.test(layer.boxColor) ? layer.boxColor : "#FFFFFF";
    const borderColor = /^#[0-9a-f]{6}$/iu.test(layer.boxBorderColor) ? layer.boxBorderColor : "#333333";
    const boxOpacity = Math.max(0, Math.min(1, number(layer.boxOpacity, 0.9)));
    const borderOpacity = Math.max(0, Math.min(1, number(layer.boxBorderOpacity, 1)));
    const borderWidth = Math.max(0, Math.min(40, number(layer.boxBorderWidth, 0)));
    const radius = Math.max(0, Math.min(120, number(layer.boxRadius, 24)));
    box = `<rect x="${boxLeft}" y="${boxTop}" width="${boxWidth}" height="${boxHeight}" rx="${radius}" ry="${radius}" fill="${boxColor}" fill-opacity="${boxOpacity}" stroke="${borderColor}" stroke-opacity="${borderOpacity}" stroke-width="${borderWidth}"/>`;
  }
  let cursorY = textTop;
  const text = preparedLines.map(item => {
    const baseline = cursorY + item.maxSize;
    cursorY += item.height;
    const spans = item.segments.map(segment => `<tspan font-size="${segment.size}" font-family="${xmlEscape(segment.font)}" font-weight="${segment.weight}" text-decoration="${segment.underline ? "underline" : "none"}">${xmlEscape(segment.text)}</tspan>`).join("");
    return `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-family="${font}" font-weight="${String(layer.weight || "700")}" fill="${color}" fill-opacity="${opacity}" stroke="#000000" stroke-opacity="${boxEnabled ? 0 : 0.45}" stroke-width="${boxEnabled ? 0 : 5}" paint-order="stroke">${spans}</text>`;
  }).join("");
  return `<g transform="rotate(${rotation} ${centerX} ${centerY})">${box}${text}</g>`;

}

function textOverlaySvg(slide, width, height) {
  const layers = slide.textLayers?.length ? slide.textLayers : (slide.textEnabled ? [{
    content: slide.overlayText, font: slide.textFont, size: slide.textSize, x: slide.textX,
    y: slide.textY, color: slide.textColor, align: slide.textAlign, enabled: true
  }] : []);
  const content = layers.map(layer => layerTextSvg(layer, width, height)).join("");
  return content ? Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${content}</svg>`) : null;
}

async function cropAsset(asset, slide, width, height) {
  const zoom = Math.max(1, Math.min(3, Number(slide.cropZoom) || 1));
  const scaledWidth = Math.ceil(width * zoom), scaledHeight = Math.ceil(height * zoom);
  const resized = await sharp(path.join(config.assetDirectory, asset.storage_key)).resize(scaledWidth, scaledHeight, { fit: "cover", position: "attention" }).toBuffer();
  const maxLeft = scaledWidth - width, maxTop = scaledHeight - height;
  const left = Math.round(maxLeft * Math.max(0, Math.min(100, Number(slide.cropX) || 50)) / 100);
  const top = Math.round(maxTop * Math.max(0, Math.min(100, Number(slide.cropY) || 50)) / 100);
  const cropped = await sharp(resized).extract({ left, top, width, height }).toBuffer();
  const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const brightness = Math.max(0.3, Math.min(2, number(slide.imageBrightness, 1)));
  const contrast = Math.max(0.3, Math.min(2, number(slide.imageContrast, 1)));
  const saturation = Math.max(0, Math.min(2, number(slide.imageSaturation, 1)));
  const grayscale = Math.max(0, Math.min(1, number(slide.imageGrayscale, 0)));
  const blur = Math.max(0, Math.min(20, number(slide.imageBlur, 0)));
  let pipeline = sharp(cropped).modulate({ brightness, saturation }).linear(contrast, 128 * (1 - contrast));
  if (grayscale > 0) {
    const red = 0.2126 * grayscale, green = 0.7152 * grayscale, blue = 0.0722 * grayscale;
    pipeline = pipeline.recomb([
      [1 - grayscale + red, green, blue],
      [red, 1 - grayscale + green, blue],
      [red, green, 1 - grayscale + blue]
    ]);
  }
  if (blur >= 0.3) pipeline = pipeline.blur(blur);
  return pipeline.toBuffer();
}

function frameOverlaySvg(slide, width, height) {
  const frameWidth = Math.max(0, Math.min(80, Number(slide.frameWidth) || 0));
  if (!frameWidth) return null;
  const maxInset = Math.floor(Math.min(width, height) / 3);
  const inset = Math.max(0, Math.min(maxInset, Number(slide.frameInset) || 0));
  const x = inset + frameWidth / 2, y = inset + frameWidth / 2;
  const rectWidth = Math.max(1, width - x * 2), rectHeight = Math.max(1, height - y * 2);
  const radius = Math.max(0, Math.min(240, Number(slide.frameRadius) || 0));
  const color = /^#[0-9a-f]{6}$/iu.test(slide.frameColor) ? slide.frameColor : "#FFFFFF";
  const opacityValue = Number(slide.frameOpacity);
  const opacity = Math.max(0, Math.min(1, Number.isFinite(opacityValue) ? opacityValue : 1));
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" rx="${radius}" ry="${radius}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${frameWidth}"/></svg>`);

}

async function renderApprovedSlide(slide) {
  const ids = slide.selectedAssetIds.length ? slide.selectedAssetIds : [slide.selectedAssetId];
  const assets = ids.map(id => sql.getAsset.get(id));
  const width = 1080, height = 1920;
  let base;
  if (slide.compositionMode !== "grid" || assets.length === 1) {
    base = await cropAsset(assets[0], slide, width, height);
  } else {
    const columns = assets.length <= 2 ? 1 : assets.length <= 6 ? 2 : 3;
    const rows = Math.ceil(assets.length / columns);
    const cellWidth = Math.floor(width / columns), cellHeight = Math.floor(height / rows);
    const composites = await Promise.all(assets.map(async (asset, index) => ({
      input: await cropAsset(asset, slide, cellWidth, cellHeight),
      left: (index % columns) * cellWidth, top: Math.floor(index / columns) * cellHeight
    })));
    base = await sharp({ create: { width, height, channels: 3, background: "#f3eee7" } }).composite(composites).png().toBuffer();
  }
  const frame = frameOverlaySvg(slide, width, height);
  const overlay = textOverlaySvg(slide, width, height);
  const composites = [frame, overlay].filter(Boolean).map(input => ({ input, left: 0, top: 0 }));
  return sharp(base).composite(composites).webp({ quality: 92 }).toBuffer();
}

export async function getApprovedAssetFiles(projectId) {
  const project = getProject(projectId);
  if (project.contentStatus !== "APPROVED") throw new AppError("CONTENT_NOT_APPROVED", "Cần duyệt nội dung trước khi tải bộ ảnh.", 409);
  if (!project.slides.every(slide => slide.selectedAssetId && slide.imageApproved)) throw new AppError("IMAGES_NOT_APPROVED", "Một số slide chưa được duyệt ảnh.", 409);
  return Promise.all(project.slides.map(async slide => ({
    buffer: await renderApprovedSlide(slide),
    name: `${String(slide.position).padStart(2, "0")}-${slide.subject.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}.webp`
  })));
}
