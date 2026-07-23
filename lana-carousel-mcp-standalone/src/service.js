import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, sql } from "./db.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { importAndStoreImage } from "./image-importer.js";

const now = () => new Date().toISOString();
const bool = (value) => Boolean(value);

function mapSlide(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    position: row.position,
    subject: row.subject,
    headline: row.headline,
    body: row.body,
    selectedAssetId: row.selected_asset_id,
    isLocked: bool(row.is_locked),
    renderStatus: row.render_status
  };
}

function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    sourceImageUrl: row.source_image_url,
    sourcePageUrl: row.source_page_url,
    sourceTitle: row.source_title,
    sourcePublisher: row.source_publisher,
    sourceType: row.source_type,
    altText: row.alt_text
  };
}

export function createProject({ title, topic = "" }) {
  const id = randomUUID();
  sql.createProject.run({ id, title, topic, created_at: now() });
  return getProject(id);
}

export function addSlide({ projectId, position, subject, headline, body }) {
  if (!sql.getProject.get(projectId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy project.", 404);
  const id = randomUUID();
  const timestamp = now();
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
  if (!project) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy project.", 404);
  const slides = sql.getSlides.all(projectId).map(mapSlide);
  const assets = sql.getAssets.all(projectId).map(mapAsset);
  return { id: project.id, title: project.title, topic: project.topic, slides, assets };
}

export async function importAssetFromUrl(input) {
  const slideRow = sql.getSlide.get(input.slideId);
  if (!slideRow) throw new AppError("SLIDE_NOT_FOUND", "Không tìm thấy slide.", 404);
  const slide = mapSlide(slideRow);
  if (slide.projectId !== input.projectId) throw new AppError("SLIDE_PROJECT_MISMATCH", "Slide không thuộc project.");
  if (slide.isLocked) throw new AppError("SLIDE_LOCKED", "Slide đang bị khóa.", 409);
  if (slide.selectedAssetId && !input.forceReplace) throw new AppError("SLIDE_ALREADY_HAS_ASSET", "Slide đã có ảnh.", 409);

  const stored = await importAndStoreImage({ imageUrl: input.imageUrl, sourcePageUrl: input.sourcePageUrl });
  let assetRow = sql.findAssetByHash.get(input.projectId, stored.sha256);
  let reused = Boolean(assetRow);

  if (assetRow) {
    await fs.unlink(stored.absolutePath).catch(() => undefined);
  } else {
    const assetId = randomUUID();
    const createdAt = now();
    const transaction = db.transaction(() => {
      sql.createAsset.run({
        id: assetId,
        project_id: input.projectId,
        storage_key: stored.storageKey,
        public_url: stored.publicUrl,
        mime_type: stored.mimeType,
        file_size: stored.fileSize,
        width: stored.width,
        height: stored.height,
        sha256: stored.sha256,
        source_image_url: stored.finalUrl,
        source_page_url: input.sourcePageUrl || null,
        source_title: input.sourceTitle || null,
        source_publisher: input.sourcePublisher || null,
        source_type: input.sourceType || "unknown",
        alt_text: input.altText || null,
        created_at: createdAt
      });
      sql.assignAsset.run(assetId, createdAt, input.slideId);
    });
    try {
      transaction();
    } catch (error) {
      await fs.unlink(stored.absolutePath).catch(() => undefined);
      throw error;
    }
    assetRow = sql.getAsset.get(assetId);
  }

  if (reused) {
    sql.assignAsset.run(assetRow.id, now(), input.slideId);
  }

  return {
    success: true,
    projectId: input.projectId,
    slideId: input.slideId,
    asset: mapAsset(assetRow),
    selectedAssetId: assetRow.id,
    reusedExistingAsset: reused,
    renderRequired: true
  };
}
