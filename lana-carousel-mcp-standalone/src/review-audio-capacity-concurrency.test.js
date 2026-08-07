import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lana-audio-capacity-race-"));
process.env.NODE_ENV = "test";
process.env.API_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
process.env.API_DAILY_MUTATION_QUOTA = "100";
process.env.API_DAILY_HEAVY_QUOTA = "100";
process.env.PROJECT_AUDIO_STAGED_TTL_SECONDS = "3600";
process.env.PROJECT_AUDIO_MAX_FILES = "5";
process.env.PROJECT_AUDIO_MAX_BYTES = "2048";
process.env.DATABASE_PATH = path.join(root, "lana.sqlite");
process.env.ASSET_DIRECTORY = path.join(root, "assets");
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:8787";
await fs.mkdir(process.env.ASSET_DIRECTORY, { recursive: true });

const service = await import("./service.js");
const { db } = await import("./db.js");
const {
  createProjectAudioAsset,
  listProjectAudioAssets,
  prepareProjectAudioClone,
  purgeOrphanedProjectAudio,
  setProjectAudioLifecycleHooksForTest,
  videoAudioDirectory
} = await import("./project-audio.js");

function fakeMp3(label, size) {
  const buffer = Buffer.alloc(size);
  buffer.write("ID3", 0, "ascii");
  buffer.write(label, 16, "utf8");
  return buffer;
}

async function projectFiles(projectId) {
  return (await fs.readdir(videoAudioDirectory))
    .filter(name => name.startsWith(`${projectId}-`));
}

function assertOneCapacityWinner(results) {
  const fulfilled = results.filter(result => result.status === "fulfilled");
  const rejected = results.filter(result => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "PROJECT_AUDIO_STORAGE_LIMIT");
  assert.equal(rejected[0].reason?.status, 413);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("SQLite trigger atomically enforces project audio cap for concurrent uploads", async () => {
  const trigger = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='project_audio_capacity_insert'
  `).get();
  assert.match(trigger?.sql || "", /RAISE\(ABORT, 'PROJECT_AUDIO_STORAGE_LIMIT'\)/u);

  const project = service.createProject({ title: "Concurrent audio upload cap" });
  await createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("baseline", 900),
    mimeType: "audio/mpeg"
  });

  const results = await Promise.allSettled([
    createProjectAudioAsset({
      projectId: project.id,
      buffer: fakeMp3("race-a", 600),
      mimeType: "audio/mpeg"
    }),
    createProjectAudioAsset({
      projectId: project.id,
      buffer: fakeMp3("race-b", 600),
      mimeType: "audio/mpeg"
    })
  ]);

  assertOneCapacityWinner(results);
  const rows = listProjectAudioAssets(project.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.file_size), 0), 1500);
  assert.ok(rows.reduce((sum, row) => sum + Number(row.file_size), 0) <= 2048);
  assert.equal((await projectFiles(project.id)).length, 2);
});

test("the same database invariant protects concurrent clone copies", async () => {
  const source = service.createProject({ title: "Clone audio source" });
  const sourceAudio = await createProjectAudioAsset({
    projectId: source.id,
    buffer: fakeMp3("clone-source", 600),
    mimeType: "audio/mpeg"
  });
  service.updateProjectVideo({
    projectId: source.id,
    enabled: true,
    settings: { audioUrl: sourceAudio.url }
  });

  const target = service.createProject({ title: "Concurrent clone target" });
  await createProjectAudioAsset({
    projectId: target.id,
    buffer: fakeMp3("target-baseline", 900),
    mimeType: "audio/mpeg"
  });

  const results = await Promise.allSettled([
    prepareProjectAudioClone(sourceAudio.url, target.id),
    prepareProjectAudioClone(sourceAudio.url, target.id)
  ]);

  assertOneCapacityWinner(results);
  const rows = listProjectAudioAssets(target.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.file_size), 0), 1500);
  assert.equal((await projectFiles(target.id)).length, 2);
});

test("periodic cleanup does not adopt an in-flight part and failed reservation leaves no row or file", async () => {
  const project = service.createProject({ title: "Periodic cleanup audio race" });
  await createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("cleanup-baseline", 900),
    mimeType: "audio/mpeg"
  });

  const reached = deferred();
  const release = deferred();
  let inFlight;

  setProjectAudioLifecycleHooksForTest({
    afterPartWrite: async payload => {
      if (payload.operation !== "upload" || payload.projectId !== project.id) return;
      inFlight = payload;
      reached.resolve();
      await release.promise;
    }
  });

  const pending = createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("cleanup-race", 600),
    mimeType: "audio/mpeg"
  });

  try {
    await reached.promise;
    assert.ok(inFlight?.storageKey);
    assert.equal((await fs.stat(inFlight.partPath)).isFile(), true);
    await assert.rejects(fs.stat(inFlight.absolutePath), error => error.code === "ENOENT");

    await purgeOrphanedProjectAudio({
      orphanGraceMs: 60_000,
      stagedGraceMs: 60 * 60_000,
      now: Date.now()
    });
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS count FROM project_audio_assets WHERE project_id=? AND storage_key=?`)
        .get(project.id, inFlight.storageKey).count,
      0
    );
    assert.equal((await fs.stat(inFlight.partPath)).isFile(), true);

    const competitorKey = `${project.id}-${randomUUID()}.mp3`;
    const competitorPath = path.join(videoAudioDirectory, competitorKey);
    await fs.writeFile(competitorPath, fakeMp3("competitor", 600), { flag: "wx" });
    db.prepare(`
      INSERT INTO project_audio_assets
        (id,project_id,storage_key,public_url,mime_type,file_size,state,referenced_at,created_at)
      VALUES (?,?,?,?,?,?,'STAGED',NULL,?)
    `).run(
      randomUUID(),
      project.id,
      competitorKey,
      `${process.env.PUBLIC_BASE_URL}/video-audio/${encodeURIComponent(competitorKey)}`,
      "audio/mpeg",
      600,
      new Date().toISOString()
    );

    release.resolve();
    await assert.rejects(
      pending,
      error => error.code === "PROJECT_AUDIO_STORAGE_LIMIT" && error.status === 413
    );
  } finally {
    release.resolve();
    setProjectAudioLifecycleHooksForTest({});
  }

  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM project_audio_assets WHERE project_id=? AND storage_key=?`)
      .get(project.id, inFlight.storageKey).count,
    0
  );
  await assert.rejects(fs.stat(inFlight.partPath), error => error.code === "ENOENT");
  await assert.rejects(fs.stat(inFlight.absolutePath), error => error.code === "ENOENT");

  const rows = listProjectAudioAssets(project.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.file_size), 0), 1500);
  assert.equal((await projectFiles(project.id)).length, 2);
});
