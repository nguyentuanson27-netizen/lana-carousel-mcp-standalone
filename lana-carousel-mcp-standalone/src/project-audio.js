import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { AppError } from "./errors.js";
import * as core from "./project-audio-core.js";

await core.migrateLegacyProjectAudio();

export const videoAudioDirectory = core.videoAudioDirectory;
export const managedProjectAudioName = core.managedProjectAudioName;
export const withoutProjectAudioSync = core.withoutProjectAudioSync;
export const listProjectAudioAssets = core.listProjectAudioAssets;
export const projectAudioOwners = core.projectAudioOwners;
export const projectAudioFileForProject = core.projectAudioFileForProject;
export const purgeStagedProjectAudio = core.purgeStagedProjectAudio;
export const deleteProjectAudioFiles = core.deleteProjectAudioFiles;
export const touchOwnedProjectAudio = core.touchOwnedProjectAudio;
export const migrateLegacyProjectAudio = core.migrateLegacyProjectAudio;

db.exec(`
CREATE TABLE IF NOT EXISTS project_audio_limits (
  id INTEGER PRIMARY KEY CHECK (id=1),
  max_files INTEGER NOT NULL CHECK (max_files>0),
  max_bytes INTEGER NOT NULL CHECK (max_bytes>0),
  updated_at TEXT NOT NULL
);
`);
db.prepare(`
  INSERT INTO project_audio_limits (id,max_files,max_bytes,updated_at)
  VALUES (1,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    max_files=excluded.max_files,
    max_bytes=excluded.max_bytes,
    updated_at=excluded.updated_at
`).run(
  config.projectAudioMaxFiles,
  config.projectAudioMaxBytes,
  new Date().toISOString()
);
db.exec(`
CREATE TRIGGER IF NOT EXISTS project_audio_capacity_insert
BEFORE INSERT ON project_audio_assets
WHEN NOT EXISTS (
  SELECT 1 FROM project_audio_assets
  WHERE project_id=NEW.project_id AND storage_key=NEW.storage_key
)
BEGIN
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM project_audio_assets WHERE project_id=NEW.project_id)
      >= (SELECT max_files FROM project_audio_limits WHERE id=1)
    OR
    (SELECT COALESCE(SUM(file_size),0) FROM project_audio_assets WHERE project_id=NEW.project_id)
      + NEW.file_size > (SELECT max_bytes FROM project_audio_limits WHERE id=1)
  THEN RAISE(ABORT, 'PROJECT_AUDIO_STORAGE_LIMIT') END;
END;
CREATE TRIGGER IF NOT EXISTS project_audio_capacity_update
BEFORE UPDATE OF project_id,storage_key,file_size ON project_audio_assets
WHEN NEW.project_id<>OLD.project_id
  OR NEW.storage_key<>OLD.storage_key
  OR NEW.file_size<>OLD.file_size
BEGIN
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM project_audio_assets
      WHERE project_id=NEW.project_id AND id<>OLD.id) + 1
      > (SELECT max_files FROM project_audio_limits WHERE id=1)
    OR
    (SELECT COALESCE(SUM(file_size),0) FROM project_audio_assets
      WHERE project_id=NEW.project_id AND id<>OLD.id) + NEW.file_size
      > (SELECT max_bytes FROM project_audio_limits WHERE id=1)
  THEN RAISE(ABORT, 'PROJECT_AUDIO_STORAGE_LIMIT') END;
END;
`);

const audioSql = {
  insert: db.prepare(`
    INSERT INTO project_audio_assets
      (id,project_id,storage_key,public_url,mime_type,file_size,state,referenced_at,created_at)
    VALUES (@id,@project_id,@storage_key,@public_url,@mime_type,@file_size,'STAGED',NULL,@created_at)
  `),
  sourceByKey: db.prepare(`
    SELECT * FROM project_audio_assets WHERE project_id=? AND storage_key=? AND state='REFERENCED'
  `),
  usageByProject: db.prepare(`
    SELECT COUNT(*) AS file_count, COALESCE(SUM(file_size),0) AS total_bytes
    FROM project_audio_assets WHERE project_id=?
  `),
  deleteByProjectAndKey: db.prepare(`
    DELETE FROM project_audio_assets WHERE project_id=? AND storage_key=?
  `),
  staleStaged: db.prepare(`
    SELECT * FROM project_audio_assets
    WHERE state='STAGED' AND created_at<=?
    ORDER BY created_at ASC
  `),
  deleteStaged: db.prepare(`
    DELETE FROM project_audio_assets
    WHERE id=? AND state='STAGED' AND created_at<=?
  `),
  allStorage: db.prepare(`SELECT DISTINCT storage_key FROM project_audio_assets`)
};

const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uploadedNamePattern = new RegExp(`^(${uuidPattern})-(${uuidPattern})\\.(?:mp3|m4a|wav)$`, "iu");
let lifecycleHooks = {};
let maintenanceHandles;

function extensionForMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (value.includes("wav")) return ".wav";
  if (value.includes("mp4") || value.includes("m4a")) return ".m4a";
  return ".mp3";
}

function mimeForName(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".m4a") return "audio/mp4";
  return "audio/mpeg";
}

function ownerProjectId(storageKey) {
  return uploadedNamePattern.exec(String(storageKey || ""))?.[1] || "";
}

function publicUrl(storageKey) {
  return `${config.publicBaseUrl.replace(/\/$/u, "")}/video-audio/${encodeURIComponent(storageKey)}`;
}

function storageLimitError() {
  return new AppError(
    "PROJECT_AUDIO_STORAGE_LIMIT",
    `Project chỉ được lưu tối đa ${config.projectAudioMaxFiles} file hoặc ${config.projectAudioMaxBytes} byte audio.`,
    413
  );
}

function mapStorageLimitError(error) {
  if (/PROJECT_AUDIO_STORAGE_LIMIT/u.test(String(error?.message || error || ""))) {
    return storageLimitError();
  }
  return error;
}

function assertProjectAudioCapacity(projectId, incomingBytes) {
  const usage = audioSql.usageByProject.get(projectId);
  if (
    Number(usage.file_count) >= config.projectAudioMaxFiles ||
    Number(usage.total_bytes) + incomingBytes > config.projectAudioMaxBytes
  ) {
    throw storageLimitError();
  }
}

async function invokeLifecycleHook(name, payload) {
  const hook = lifecycleHooks[name];
  if (typeof hook === "function") await hook(payload);
}

export function setProjectAudioLifecycleHooksForTest(hooks = {}) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Project audio lifecycle hooks are test-only.");
  }
  lifecycleHooks = hooks && typeof hooks === "object" ? hooks : {};
}

async function removeWriteArtifacts(projectId, storageKey, ...files) {
  audioSql.deleteByProjectAndKey.run(projectId, storageKey);
  await Promise.all(files.filter(Boolean).map(file => fs.unlink(file).catch(error => {
    if (error?.code !== "ENOENT") throw error;
  })));
}

async function persistPreparedAudio({
  operation,
  projectId,
  storageKey,
  mimeType,
  fileSize,
  writePart
}) {
  const absolutePath = path.join(videoAudioDirectory, storageKey);
  const partPath = path.join(videoAudioDirectory, `.${storageKey}.${randomUUID()}.part`);
  const createdAt = new Date().toISOString();

  try {
    await writePart(partPath);
    await invokeLifecycleHook("afterPartWrite", {
      operation,
      projectId,
      storageKey,
      absolutePath,
      partPath,
      fileSize
    });

    audioSql.insert.run({
      id: randomUUID(),
      project_id: projectId,
      storage_key: storageKey,
      public_url: publicUrl(storageKey),
      mime_type: mimeType,
      file_size: fileSize,
      created_at: createdAt
    });
    await invokeLifecycleHook("afterReservation", {
      operation,
      projectId,
      storageKey,
      absolutePath,
      partPath,
      fileSize
    });

    await fs.rename(partPath, absolutePath);
    return {
      projectId,
      storageKey,
      absolutePath,
      url: publicUrl(storageKey),
      mimeType,
      size: fileSize,
      state: "STAGED"
    };
  } catch (error) {
    await removeWriteArtifacts(projectId, storageKey, partPath, absolutePath);
    throw mapStorageLimitError(error);
  }
}

export async function createProjectAudioAsset({ projectId, buffer, mimeType = "audio/mpeg" }) {
  if (!sql.getProject.get(projectId)) {
    throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new AppError("AUDIO_EMPTY", "File âm thanh rỗng.", 400);
  }

  await core.purgeStagedProjectAudio({ projectId });
  assertProjectAudioCapacity(projectId, buffer.length);

  const storageKey = `${projectId}-${randomUUID()}${extensionForMime(mimeType)}`;
  return persistPreparedAudio({
    operation: "upload",
    projectId,
    storageKey,
    mimeType,
    fileSize: buffer.length,
    writePart: partPath => fs.writeFile(partPath, buffer, { flag: "wx" })
  });
}

export async function prepareProjectAudioClone(rawUrl, targetProjectId) {
  if (!rawUrl) return null;
  if (!sql.getProject.get(targetProjectId)) {
    throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án bản sao.", 404);
  }

  const sourceKey = core.managedProjectAudioName(rawUrl);
  if (!sourceKey) return null;
  const sourceProjectId = ownerProjectId(sourceKey);
  const sourceRow = sourceProjectId
    ? audioSql.sourceByKey.get(sourceProjectId, sourceKey)
    : null;
  if (!sourceRow) {
    throw new AppError(
      "AUDIO_NOT_OWNED",
      `Project ${sourceProjectId || "unknown"} không sở hữu file audio ${sourceKey || "này"}.`,
      403
    );
  }

  const sourcePath = path.join(videoAudioDirectory, sourceKey);
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new AppError("AUDIO_FILE_MISSING", "Không tìm thấy file nhạc nền của dự án gốc.", 409);
  }

  await core.purgeStagedProjectAudio({ projectId: targetProjectId });
  assertProjectAudioCapacity(targetProjectId, stat.size);

  const storageKey = `${targetProjectId}-${randomUUID()}${path.extname(sourceKey) || ".mp3"}`;
  return persistPreparedAudio({
    operation: "clone",
    projectId: targetProjectId,
    storageKey,
    mimeType: mimeForName(storageKey),
    fileSize: stat.size,
    writePart: partPath => fs.copyFile(sourcePath, partPath, fsSync.constants.COPYFILE_EXCL)
  });
}

export async function purgeOrphanedProjectAudio({
  orphanGraceMs = 60 * 60_000,
  stagedGraceMs = config.projectAudioStagedTtlMs,
  now = Date.now()
} = {}) {
  const stagedCutoffIso = new Date(now - stagedGraceMs).toISOString();
  let deleted = 0;

  for (const row of audioSql.staleStaged.all(stagedCutoffIso)) {
    if (audioSql.deleteStaged.run(row.id, stagedCutoffIso).changes < 1) continue;
    const storageKey = String(row.storage_key || "");
    if (storageKey && path.basename(storageKey) === storageKey) {
      await fs.unlink(path.join(videoAudioDirectory, storageKey)).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    deleted += 1;
  }

  const known = new Set(audioSql.allStorage.all().map(row => row.storage_key));
  for (const entry of await fs.readdir(videoAudioDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const isManagedFinal = /\.(?:mp3|m4a|wav)$/iu.test(entry.name);
    const isPart = /\.part$/iu.test(entry.name);
    if (!isManagedFinal && !isPart) continue;
    if (isManagedFinal && known.has(entry.name)) continue;

    const file = path.join(videoAudioDirectory, entry.name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.mtimeMs > now - orphanGraceMs) continue;
    await fs.unlink(file).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
    deleted += 1;
  }

  return deleted;
}

export function startProjectAudioMaintenance({
  setIntervalFn = globalThis.setInterval,
  intervalMs = 60 * 60_000
} = {}) {
  if (maintenanceHandles) return maintenanceHandles;
  const touchTimer = setIntervalFn(
    () => core.touchOwnedProjectAudio().catch(() => undefined),
    intervalMs
  );
  const purgeTimer = setIntervalFn(
    () => purgeOrphanedProjectAudio().catch(() => undefined),
    intervalMs
  );
  touchTimer.unref?.();
  purgeTimer.unref?.();
  maintenanceHandles = { touchTimer, purgeTimer };
  return maintenanceHandles;
}

await core.touchOwnedProjectAudio();
await purgeOrphanedProjectAudio();
startProjectAudioMaintenance();
