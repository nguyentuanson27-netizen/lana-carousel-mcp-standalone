import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-ui-review-"));
process.env.DATABASE_PATH = path.join(tempDirectory, "review.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempDirectory, "assets");

const { db, sql } = await import(`./db.js?review-4880008318=${Date.now()}`);
const now = new Date().toISOString();

after(async () => {
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

function insertProject(id) {
  db.prepare(`
    INSERT INTO projects (id,title,topic,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,?,?)
  `).run(id, "Review project", "", now, now, "2099-01-01T00:00:00.000Z");
}

function insertSlide({ id, projectId, selectedAssetId = null, approved = 0 }) {
  db.prepare(`
    INSERT INTO slides (
      id,project_id,position,subject,headline,body,selected_asset_id,
      is_locked,render_status,created_at,updated_at,image_approved
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, projectId, 1, "Subject", "Headline", "Body", selectedAssetId, 0, "DIRTY", now, now, approved);
}

function insertAsset({ id, projectId, url, sha }) {
  db.prepare(`
    INSERT INTO assets (
      id,project_id,storage_key,public_url,mime_type,file_size,width,height,
      sha256,source_image_url,source_type,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, projectId, `${id}.webp`, url, "image/webp", 100, 1080, 1920, sha, "https://example.com/source.webp", "web", now);
}

test("dashboard thumbnail only exposes assets from an approved slide", () => {
  insertProject("project-review");
  insertAsset({
    id: "asset-direct",
    projectId: "project-review",
    url: "/assets/direct.webp",
    sha: "1111111111111111111111111111111111111111111111111111111111111111"
  });
  insertSlide({
    id: "slide-review",
    projectId: "project-review",
    selectedAssetId: "asset-direct",
    approved: 0
  });

  assert.equal(sql.getProjectThumbnail.get("project-review"), undefined);

  db.prepare("UPDATE slides SET image_approved=1 WHERE id=?").run("slide-review");
  assert.equal(sql.getProjectThumbnail.get("project-review").public_url, "/assets/direct.webp");

  db.prepare("UPDATE slides SET image_approved=0 WHERE id=?").run("slide-review");
  assert.equal(sql.getProjectThumbnail.get("project-review"), undefined);

  insertAsset({
    id: "asset-grid",
    projectId: "project-review",
    url: "/assets/grid.webp",
    sha: "2222222222222222222222222222222222222222222222222222222222222222"
  });
  db.prepare("UPDATE slides SET image_approved=1, selected_asset_id=NULL, composition_mode='grid' WHERE id=?").run("slide-review");
  db.prepare("INSERT INTO slide_asset_selections (slide_id,asset_id,position) VALUES (?,?,?)")
    .run("slide-review", "asset-grid", 0);

  assert.equal(sql.getProjectThumbnail.get("project-review").public_url, "/assets/grid.webp");
});

test("wheel navigation and slide rail share the active filter collection", async () => {
  const source = await fs.readFile(new URL("../public/stitch-ui.js", import.meta.url), "utf8");
  const railStart = source.indexOf("function refreshRail");
  const railEnd = source.indexOf("function escapeHtml", railStart);
  const stepStart = source.indexOf("function stepSlide");
  const stepEnd = source.indexOf("workspaceShell?.addEventListener", stepStart);

  assert.ok(source.includes("function filterItems(items)"));
  assert.match(source.slice(railStart, railEnd), /const filtered = filterItems\(items\);/u);
  assert.match(source.slice(stepStart, stepEnd), /const items = filterItems\(getCards\(view\)\);/u);
});
