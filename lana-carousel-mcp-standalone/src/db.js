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
`);

export const sql = {
  createProject: db.prepare(`
    INSERT INTO projects (id, title, topic, created_at)
    VALUES (@id, @title, @topic, @created_at)
  `),
  getProject: db.prepare(`SELECT * FROM projects WHERE id = ?`),
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
  getAssets: db.prepare(`SELECT * FROM assets WHERE project_id = ? ORDER BY created_at ASC`),
  getAsset: db.prepare(`SELECT * FROM assets WHERE id = ?`),
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
  `)
};
