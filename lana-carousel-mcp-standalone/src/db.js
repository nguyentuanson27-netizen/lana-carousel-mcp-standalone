import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS slides (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  subject TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  selected_asset_id TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  render_status TEXT NOT NULL DEFAULT 'DIRTY',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, position)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source_image_url TEXT NOT NULL,
  source_page_url TEXT,
  source_title TEXT,
  source_publisher TEXT,
  source_type TEXT NOT NULL DEFAULT 'unknown',
  alt_text TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, sha256)
);

CREATE INDEX IF NOT EXISTS idx_slides_project ON slides(project_id, position);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id);

CREATE TABLE IF NOT EXISTS slide_asset_candidates (
  slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slide_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_slide ON slide_asset_candidates(slide_id, created_at);

CREATE TABLE IF NOT EXISTS slide_asset_selections (
  slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (slide_id, asset_id)
);

CREATE TABLE IF NOT EXISTS project_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_versions ON project_versions(project_id, created_at DESC);
`);

const projectColumns = new Set(db.prepare(`PRAGMA table_info(projects)`).all().map(column => column.name));
if (!projectColumns.has("content_status")) {
  db.exec(`ALTER TABLE projects ADD COLUMN content_status TEXT NOT NULL DEFAULT 'PENDING'`);
}
if (!projectColumns.has("image_status")) {
  db.exec(`ALTER TABLE projects ADD COLUMN image_status TEXT NOT NULL DEFAULT 'PENDING'`);
}
if (!projectColumns.has("slide_limit")) {
  db.exec(`ALTER TABLE projects ADD COLUMN slide_limit INTEGER NOT NULL DEFAULT 10`);
}
if (!projectColumns.has("expires_at")) {
  db.exec(`ALTER TABLE projects ADD COLUMN expires_at TEXT`);
  db.exec(`UPDATE projects SET expires_at = datetime(created_at, '+14 days') WHERE expires_at IS NULL`);
}
for (const [name, definition] of Object.entries({
  brand_font: "TEXT NOT NULL DEFAULT 'TikTok Sans'",
  brand_color: "TEXT NOT NULL DEFAULT '#FFFFFF'",
  updated_at: "TEXT"
})) {
  if (!projectColumns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${definition}`);
}
const slideColumns = new Set(db.prepare(`PRAGMA table_info(slides)`).all().map(column => column.name));
if (!slideColumns.has("image_approved")) {
  db.exec(`ALTER TABLE slides ADD COLUMN image_approved INTEGER NOT NULL DEFAULT 0`);
}
if (!slideColumns.has("composition_mode")) {
  db.exec(`ALTER TABLE slides ADD COLUMN composition_mode TEXT NOT NULL DEFAULT 'crop'`);
}
for (const [name, definition] of Object.entries({
  text_enabled: "INTEGER NOT NULL DEFAULT 0",
  overlay_text: "TEXT",
  text_font: "TEXT NOT NULL DEFAULT 'TikTok Sans'",
  text_size: "INTEGER NOT NULL DEFAULT 72",
  text_position: "TEXT NOT NULL DEFAULT 'bottom'",
  text_color: "TEXT NOT NULL DEFAULT '#FFFFFF'",
  text_align: "TEXT NOT NULL DEFAULT 'center'",
  text_x: "REAL NOT NULL DEFAULT 50",
  text_y: "REAL NOT NULL DEFAULT 80"
  ,crop_x: "REAL NOT NULL DEFAULT 50"
  ,crop_y: "REAL NOT NULL DEFAULT 50"
  ,crop_zoom: "REAL NOT NULL DEFAULT 1"
  ,text_layers: "TEXT"
})) {
  if (!slideColumns.has(name)) db.exec(`ALTER TABLE slides ADD COLUMN ${name} ${definition}`);
}
db.exec(`
  INSERT OR IGNORE INTO slide_asset_candidates (slide_id, asset_id, created_at)
  SELECT id, selected_asset_id, updated_at
  FROM slides
  WHERE selected_asset_id IS NOT NULL
`);

export const sql = {
  createProject: db.prepare(`
    INSERT INTO projects (id, title, topic, slide_limit, created_at, expires_at)
    VALUES (@id, @title, @topic, @slide_limit, @created_at, @expires_at)
  `),
  getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
  getExpiredProjects: db.prepare(`SELECT id, title, expires_at FROM projects WHERE datetime(expires_at) <= datetime('now')`),
  getProjectAssetFiles: db.prepare(`SELECT storage_key FROM assets WHERE project_id = ?`),
  deleteProject: db.prepare(`DELETE FROM projects WHERE id = ?`),
  listProjects: db.prepare(`SELECT id, title, topic, content_status, image_status, created_at, updated_at, expires_at FROM projects ORDER BY created_at DESC`),
  extendProject: db.prepare(`UPDATE projects SET expires_at = datetime(CASE WHEN datetime(expires_at) > datetime('now') THEN expires_at ELSE 'now' END, '+' || ? || ' days'), updated_at = ? WHERE id = ?`),
  updateBrandKit: db.prepare(`UPDATE projects SET brand_font = ?, brand_color = ?, updated_at = ? WHERE id = ?`),
  createSlide: db.prepare(`
    INSERT INTO slides (
      id, project_id, position, subject, headline, body,
      selected_asset_id, is_locked, render_status, created_at, updated_at
    ) VALUES (
      @id, @project_id, @position, @subject, @headline, @body,
      NULL, 0, 'DIRTY', @created_at, @updated_at
    )
  `),
  getSlide: db.prepare(`SELECT * FROM slides WHERE id = ?`),
  getSlides: db.prepare(`SELECT * FROM slides WHERE project_id = ? ORDER BY position ASC`),
  countSlides: db.prepare(`SELECT COUNT(*) AS count FROM slides WHERE project_id = ?`),
  getSlideBySubject: db.prepare(`SELECT * FROM slides WHERE project_id = ? AND lower(trim(subject)) = lower(trim(?)) LIMIT 1`),
  updateSlideCrop: db.prepare(`UPDATE slides SET crop_x = ?, crop_y = ?, crop_zoom = ?, render_status = 'DIRTY', updated_at = ? WHERE id = ? AND project_id = ?`),
  getAssets: db.prepare(`SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC`),
  getAsset: db.prepare(`SELECT * FROM assets WHERE id = ?`),
  getCandidates: db.prepare(`SELECT asset_id FROM slide_asset_candidates WHERE slide_id = ? ORDER BY created_at ASC`),
  countCandidates: db.prepare(`SELECT COUNT(*) AS count FROM slide_asset_candidates WHERE slide_id = ?`),
  getSelections: db.prepare(`SELECT asset_id FROM slide_asset_selections WHERE slide_id = ? ORDER BY position ASC`),
  clearSelections: db.prepare(`DELETE FROM slide_asset_selections WHERE slide_id = ?`),
  addSelection: db.prepare(`INSERT INTO slide_asset_selections (slide_id, asset_id, position) VALUES (?, ?, ?)`),
  addCandidate: db.prepare(`
    INSERT OR IGNORE INTO slide_asset_candidates (slide_id, asset_id, created_at)
    VALUES (?, ?, ?)
  `),
  findAssetByHash: db.prepare(`SELECT * FROM assets WHERE project_id = ? AND sha256 = ?`),
  createAsset: db.prepare(`
    INSERT INTO assets (
      id, project_id, storage_key, public_url, mime_type, file_size,
      width, height, sha256, source_image_url, source_page_url,
      source_title, source_publisher, source_type, alt_text, created_at
    ) VALUES (
      @id, @project_id, @storage_key, @public_url, @mime_type, @file_size,
      @width, @height, @sha256, @source_image_url, @source_page_url,
      @source_title, @source_publisher, @source_type, @alt_text, @created_at
    )
  `),
  assignAsset: db.prepare(`
    UPDATE slides
    SET selected_asset_id = ?, render_status = 'DIRTY', updated_at = ?
    WHERE id = ?
  `),
  updateSlideContent: db.prepare(`
    UPDATE slides SET headline = @headline, body = @body, text_enabled = @text_enabled,
      overlay_text = @overlay_text, text_font = @text_font, text_size = @text_size,
      text_position = @text_position, text_color = @text_color, text_align = @text_align,
      text_x = @text_x, text_y = @text_y,
      text_layers = @text_layers,
      render_status = 'DIRTY', updated_at = @updated_at
    WHERE id = @id AND project_id = @project_id
  `),
  markSlideImagePending: db.prepare(`UPDATE slides SET image_approved = 0 WHERE id = ?`),
  approveSlideAsset: db.prepare(`
    UPDATE slides
    SET selected_asset_id = ?, composition_mode = ?, image_approved = 1, render_status = 'DIRTY', updated_at = ?
    WHERE id = ?
  `),
  approveContent: db.prepare(`UPDATE projects SET content_status = 'APPROVED' WHERE id = ?`),
  markImagesPending: db.prepare(`UPDATE projects SET image_status = 'PENDING' WHERE id = ?`),
  approveImages: db.prepare(`UPDATE projects SET image_status = 'APPROVED' WHERE id = ?`)
  ,updateProjectStatuses: db.prepare(`UPDATE projects SET content_status = ?, image_status = ?, updated_at = ? WHERE id = ?`)
  ,createVersion: db.prepare(`INSERT INTO project_versions (id, project_id, action, snapshot, created_at) VALUES (?, ?, ?, ?, ?)`)
  ,getVersions: db.prepare(`SELECT id, action, created_at FROM project_versions WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`)
  ,getVersion: db.prepare(`SELECT * FROM project_versions WHERE id = ? AND project_id = ?`)
};
