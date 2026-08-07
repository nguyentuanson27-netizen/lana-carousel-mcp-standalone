import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lana-review-idle-audio-"));
process.env.NODE_ENV = "test";
process.env.API_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.API_DAILY_MUTATION_QUOTA = "100";
process.env.API_DAILY_HEAVY_QUOTA = "100";
process.env.DATABASE_PATH = path.join(root, "lana.sqlite");
process.env.ASSET_DIRECTORY = path.join(root, "assets");
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:8787";
await fs.mkdir(process.env.ASSET_DIRECTORY, { recursive: true });

const service = await import("./service.js");
const { db, sql } = await import("./db.js");
const {
  createProjectAudioAsset,
  listProjectAudioAssets,
  touchOwnedProjectAudio,
  videoAudioDirectory
} = await import("./project-audio.js");
const { McpPrincipalBindings } = await import("./mcp-principal-binding.js");

function fakeMp3() {
  const buffer = Buffer.alloc(256);
  buffer.write("ID3", 0, "ascii");
  return buffer;
}

test("MCP principal binding fails closed after idle purge", () => {
  const bindings = new McpPrincipalBindings({ ttlMs: 10 });
  bindings.bind("session-a", "key:a");
  const entry = bindings.sessions.get("session-a");
  const removed = bindings.purge(entry.touchedAt + 11);
  assert.deepEqual(removed, ["session-a"]);
  assert.throws(
    () => bindings.assert("session-a", "key:b"),
    error => error.code === "MCP_SESSION_BINDING_MISSING" && error.status === 403
  );
  assert.throws(
    () => bindings.assert("session-a", "key:a"),
    error => error.code === "MCP_SESSION_BINDING_MISSING"
  );
});

test("project audio survives retention, clones independently, and deletes with owner", async () => {
  const source = service.createProject({ title: "Audio source" });
  const uploaded = await createProjectAudioAsset({
    projectId: source.id,
    buffer: fakeMp3(),
    mimeType: "audio/mpeg"
  });
  service.updateProjectVideo({
    projectId: source.id,
    enabled: true,
    settings: { audioUrl: uploaded.url }
  });
  assert.equal(listProjectAudioAssets(source.id).length, 1);

  const old = new Date(Date.now() - 20 * 864e5);
  await fs.utimes(uploaded.absolutePath, old, old);
  await touchOwnedProjectAudio();
  const touched = await fs.stat(uploaded.absolutePath);
  assert.ok(touched.mtimeMs > Date.now() - 60_000);

  const clone = await service.cloneProject(source.id);
  assert.notEqual(clone.videoSettings.audioUrl, uploaded.url);
  assert.match(new URL(clone.videoSettings.audioUrl).pathname, new RegExp(`/video-audio/${clone.id}-`, "u"));
  const cloneRows = listProjectAudioAssets(clone.id);
  assert.equal(cloneRows.length, 1);
  const cloneFile = path.join(videoAudioDirectory, cloneRows[0].storage_key);
  assert.equal((await fs.stat(cloneFile)).isFile(), true);

  await service.deleteProject(source.id);
  assert.equal((await fs.stat(cloneFile)).isFile(), true);
  await assert.rejects(fs.stat(uploaded.absolutePath), error => error.code === "ENOENT");

  await service.deleteProject(clone.id);
  await assert.rejects(fs.stat(cloneFile), error => error.code === "ENOENT");
});

test("stale concurrent SHA lookup recovers as duplicate instead of 500", async () => {
  const project = service.createProject({ title: "Same SHA race" });
  const slide = service.addSlide({
    projectId: project.id,
    position: 1,
    subject: "Look",
    headline: "Look",
    body: "Body"
  });

  const originalFind = sql.findAssetByHash;
  let staleReads = 2;
  sql.findAssetByHash = {
    get(...args) {
      if (staleReads > 0) {
        staleReads -= 1;
        return undefined;
      }
      return originalFind.get(...args);
    }
  };

  let sequence = 0;
  const importer = async () => {
    sequence += 1;
    const storageKey = `same-sha-${sequence}.webp`;
    const absolutePath = path.join(process.env.ASSET_DIRECTORY, storageKey);
    await fs.writeFile(absolutePath, String(sequence));
    return {
      storageKey,
      absolutePath,
      publicUrl: `${process.env.PUBLIC_BASE_URL}/assets/${storageKey}`,
      mimeType: "image/webp",
      fileSize: 1,
      width: 1,
      height: 1,
      sha256: "same-content-hash",
      finalUrl: `https://cdn.example.com/${storageKey}`
    };
  };

  try {
    const results = await Promise.all([
      service.importAssetFromUrl({
        projectId: project.id,
        slideId: slide.id,
        imageUrl: "https://cdn.example.com/a.webp",
        selectAsset: false,
        importer
      }),
      service.importAssetFromUrl({
        projectId: project.id,
        slideId: slide.id,
        imageUrl: "https://cdn.example.com/b.webp",
        selectAsset: false,
        importer
      })
    ]);
    assert.equal(results.filter(result => result.candidateAdded).length, 1);
    assert.equal(results.filter(result => result.duplicateCandidate).length, 1);
    assert.equal(sql.countCandidates.get(slide.id).count, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM assets WHERE project_id=?`).get(project.id).count, 1);
    const remaining = await fs.readdir(process.env.ASSET_DIRECTORY);
    assert.equal(remaining.filter(name => name.startsWith("same-sha-")).length, 1);
    assert.equal(remaining.filter(name => name.startsWith(".duplicate-retry-")).length, 0);
  } finally {
    sql.findAssetByHash = originalFind;
  }
});
