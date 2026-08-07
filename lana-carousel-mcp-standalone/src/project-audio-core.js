import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { AppError } from "./errors.js";

export const videoAudioDirectory = path.resolve(path.dirname(config.databasePath), "video-audio");
await fs.mkdir(videoAudioDirectory, { recursive: true });

db.exec(`
CREATE TABLE IF NOT EXISTS project_audio_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'STAGED',
  referenced_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, storage_key)
);
`);
const audioColumns = new Set(
  db.prepare(`PRAGMA table_info(project_audio_assets)`).all().map(column => column.name)
);
if (!audioColumns.has("state")) {
  db.exec(`ALTER TABLE project_audio_assets ADD COLUMN state TEXT NOT NULL DEFAULT 'STAGED'`);
}
if (!audioColumns.has("referenced_at")) {
  db.exec(`ALTER TABLE project_audio_assets ADD COLUMN referenced_at TEXT`);
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_project_audio_assets_project
  ON project_audio_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_audio_assets_storage
  ON project_audio_assets(storage_key);
CREATE INDEX IF NOT EXISTS idx_project_audio_assets_state_created
  ON project_audio_assets(state, created_at);
`);

const audioSql = {
  insert: db.prepare(`
    INSERT INTO project_audio_assets
      (id,project_id,storage_key,public_url,mime_type,file_size,state,referenced_at,created_at)
    VALUES (@id,@project_id,@storage_key,@public_url,@mime_type,@file_size,@state,@referenced_at,@created_at)
    ON CONFLICT(project_id,storage_key) DO UPDATE SET
      public_url=excluded.public_url,
      mime_type=excluded.mime_type,
      file_size=excluded.file_size,
      state=CASE
        WHEN project_audio_assets.state='REFERENCED' THEN 'REFERENCED'
        ELSE excluded.state
      END,
      referenced_at=COALESCE(project_audio_assets.referenced_at, excluded.referenced_at)
  `),
  byProject: db.prepare(`SELECT * FROM project_audio_assets WHERE project_id=? ORDER BY created_at ASC`),
  byProjectAndKey: db.prepare(`SELECT * FROM project_audio_assets WHERE project_id=? AND storage_key=?`),
  byStorage: db.prepare(`SELECT * FROM project_audio_assets WHERE storage_key=? ORDER BY created_at ASC`),
  referencedStorage: db.prepare(`SELECT DISTINCT storage_key FROM project_audio_assets WHERE state='REFERENCED'`),
  staleStagedForProject: db.prepare(`
    SELECT * FROM project_audio_assets
    WHERE project_id=? AND state='STAGED' AND created_at<=?
    ORDER BY created_at ASC
  `),
  deleteStaged: db.prepare(`
    DELETE FROM project_audio_assets
    WHERE id=? AND state='STAGED' AND created_at<=?
  `),
  markReferenced: db.prepare(`
    UPDATE project_audio_assets
    SET state='REFERENCED', referenced_at=COALESCE(referenced_at, ?)
    WHERE project_id=? AND storage_key=?
  `)
};

const syncContext = new AsyncLocalStorage();
const originalUpdateVideoSettings = sql.updateVideoSettings;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const uploadedNamePattern = new RegExp(`^(${uuidPattern})-(${uuidPattern})\\.(?:mp3|m4a|wav)$`, "iu");
let migrationPromise;

function mimeForName(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".m4a") return "audio/mp4";
  return "audio/mpeg";
}

function ownerProjectId(storageKey) {
  return uploadedNamePattern.exec(String(storageKey || ""))?.[1] || "";
}

export function managedProjectAudioName(rawUrl) {
  try {
    const target = new URL(rawUrl);
    const base = new URL(config.publicBaseUrl);
    if (target.origin !== base.origin || !target.pathname.startsWith("/video-audio/")) return "";
    const encoded = target.pathname.slice("/video-audio/".length);
    if (!encoded || encoded.includes("/")) return "";
    const name = decodeURIComponent(encoded);
    if (!name || path.basename(name) !== name || name.startsWith(".")) return "";
    return name;
  } catch {
    return "";
  }
}

function publicUrl(storageKey) {
  return `${config.publicBaseUrl.replace(/\/$/u, "")}/video-audio/${encodeURIComponent(storageKey)}`;
}

function audioOwnershipError(projectId, storageKey) {
  return new AppError(
    "AUDIO_NOT_OWNED",
    `Project ${projectId} không sở hữu file audio ${storageKey || "này"}.`,
    403
  );
}

function insertAudioRow({
  projectId,
  storageKey,
  mimeType,
  fileSize,
  createdAt,
  state = "STAGED",
  referencedAt = null
}) {
  audioSql.insert.run({
    id: audioSql.byProjectAndKey.get(projectId, storageKey)?.id || randomUUID(),
    project_id: projectId,
    storage_key: storageKey,
    public_url: publicUrl(storageKey),
    mime_type: mimeType,
    file_size: fileSize,
    state,
    referenced_at: referencedAt,
    created_at: createdAt
  });
}

function registerManagedAudioSync(projectId, rawUrl, { requireExistingRow = false, referenced = false } = {}) {
  const storageKey = managedProjectAudioName(rawUrl);
  if (!storageKey) return null;
  if (ownerProjectId(storageKey) !== String(projectId)) throw audioOwnershipError(projectId, storageKey);

  const existing = audioSql.byProjectAndKey.get(projectId, storageKey);
  if (requireExistingRow && !existing) throw audioOwnershipError(projectId, storageKey);

  const absolutePath = path.join(videoAudioDirectory, storageKey);
  const stat = fsSync.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new AppError("AUDIO_FILE_MISSING", "Không tìm thấy file nhạc nền của project.", 409);
  }

  if (!existing) {
    insertAudioRow({
      projectId,
      storageKey,
      mimeType: mimeForName(storageKey),
      fileSize: stat.size,
      createdAt: new Date(stat.birthtimeMs || stat.mtimeMs || Date.now()).toISOString(),
      state: referenced ? "REFERENCED" : "STAGED",
      referencedAt: referenced ? new Date().toISOString() : null
    });
  } else if (referenced && existing.state !== "REFERENCED") {
    audioSql.markReferenced.run(new Date().toISOString(), projectId, storageKey);
  }
  return {
    storageKey,
    absolutePath,
    row: audioSql.byProjectAndKey.get(projectId, storageKey)
  };
}

async function adoptUploadedAudio(storageKey) {
  const projectId = ownerProjectId(storageKey);
  if (!projectId || !sql.getProject.get(projectId)) return false;
  const absolutePath = path.join(videoAudioDirectory, storageKey);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) return false;
  insertAudioRow({
    projectId,
    storageKey,
    mimeType: mimeForName(storageKey),
    fileSize: stat.size,
    createdAt: new Date(stat.birthtimeMs || stat.mtimeMs || Date.now()).toISOString()
  });
  return true;
}

function registerExistingAudio(projectId, settingsJson) {
  if (syncContext.getStore()?.suppressed) return;
  let settings = {};
  try { settings = JSON.parse(settingsJson || "{}") || {}; } catch { settings = {}; }
  const storageKey = managedProjectAudioName(settings.audioUrl || "");
  if (!storageKey) return;
  registerManagedAudioSync(projectId, settings.audioUrl, {
    requireExistingRow: true,
    referenced: true
  });
}

sql.updateVideoSettings = {
  run(enabled, settingsJson, updatedAt, projectId) {
    return db.transaction(() => {
      registerExistingAudio(projectId, settingsJson);
      return originalUpdateVideoSettings.run(enabled, settingsJson, updatedAt, projectId);
    })();
  }
};

export function withoutProjectAudioSync(callback) {
  return syncContext.run({ suppressed: true }, callback);
}

export function listProjectAudioAssets(projectId) {
  return audioSql.byProject.all(projectId);
}

export function projectAudioOwners(storageKey) {
  return audioSql.byStorage.all(storageKey).map(row => row.project_id);
}

export async function projectAudioFileForProject(projectId, rawUrl) {
  const storageKey = managedProjectAudioName(rawUrl);
  if (!storageKey || ownerProjectId(storageKey) !== String(projectId)) {
    throw audioOwnershipError(projectId, storageKey);
  }
  const row = audioSql.byProjectAndKey.get(projectId, storageKey);
  if (!row || row.state !== "REFERENCED") throw audioOwnershipError(projectId, storageKey);
  const absolutePath = path.join(videoAudioDirectory, storageKey);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new AppError("AUDIO_FILE_MISSING", "Không tìm thấy file nhạc nền của project.", 409);
  }
  return { row, storageKey, absolutePath };
}

async function deleteStagedRows(rows, cutoffIso) {
  let deleted = 0;
  for (const row of rows) {
    if (audioSql.deleteStaged.run(row.id, cutoffIso).changes < 1) continue;
    const storageKey = String(row.storage_key || "");
    if (storageKey && path.basename(storageKey) === storageKey) {
      await fs.unlink(path.join(videoAudioDirectory, storageKey)).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    deleted += 1;
  }
  return deleted;
}

export async function purgeStagedProjectAudio({
  projectId,
  stagedGraceMs = config.projectAudioStagedTtlMs,
  now = Date.now()
} = {}) {
  if (!projectId) return 0;
  const cutoffIso = new Date(now - stagedGraceMs).toISOString();
  return deleteStagedRows(audioSql.staleStagedForProject.all(projectId, cutoffIso), cutoffIso);
}

export async function deleteProjectAudioFiles(rows) {
  let deleted = 0;
  for (const row of rows || []) {
    const storageKey = String(row.storage_key || "");
    if (!storageKey || path.basename(storageKey) !== storageKey) continue;
    const owners = audioSql.byStorage.all(storageKey);
    if (owners.length) continue;
    const removed = await fs.unlink(path.join(videoAudioDirectory, storageKey)).then(() => true, error => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (removed) deleted += 1;
  }
  return deleted;
}

export async function touchOwnedProjectAudio() {
  const timestamp = new Date();
  let touched = 0;
  for (const { storage_key: storageKey } of audioSql.referencedStorage.all()) {
    if (!storageKey || path.basename(storageKey) !== storageKey) continue;
    const file = path.join(videoAudioDirectory, storageKey);
    const ok = await fs.utimes(file, timestamp, timestamp).then(() => true, () => false);
    if (ok) touched += 1;
  }
  return touched;
}

function migrateAudioReference(projectId, rawUrl) {
  if (!rawUrl || !managedProjectAudioName(rawUrl)) return;
  try {
    registerManagedAudioSync(projectId, rawUrl, { referenced: true });
  } catch (error) {
    if (!["AUDIO_NOT_OWNED", "AUDIO_FILE_MISSING"].includes(error?.code)) throw error;
  }
}

export function migrateLegacyProjectAudio() {
  migrationPromise ??= (async () => {
    for (const entry of await fs.readdir(videoAudioDirectory, { withFileTypes: true })) {
      if (entry.isFile()) await adoptUploadedAudio(entry.name);
    }
    for (const project of db.prepare(`
      SELECT id,video_settings FROM projects WHERE video_settings IS NOT NULL
    `).all()) {
      let settings = {};
      try { settings = JSON.parse(project.video_settings || "{}") || {}; } catch { settings = {}; }
      migrateAudioReference(project.id, settings.audioUrl || "");
    }
    for (const version of db.prepare(`SELECT project_id,snapshot FROM project_versions`).all()) {
      let snapshot = {};
      try { snapshot = JSON.parse(version.snapshot || "{}") || {}; } catch { snapshot = {}; }
      migrateAudioReference(version.project_id, snapshot.videoSettings?.audioUrl || "");
    }
  })();
  return migrationPromise;
}
