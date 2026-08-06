import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lana-review-audio-mcp-lifecycle-"));
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
  projectAudioFileForProject,
  purgeOrphanedProjectAudio,
  touchOwnedProjectAudio
} = await import("./project-audio.js");
const { audioDataUrl } = await import("./video-jobs.js");
const { McpPrincipalBindings } = await import("./mcp-principal-binding.js");

function fakeMp3(label = "audio", size = 256) {
  const buffer = Buffer.alloc(size);
  buffer.write("ID3", 0, "ascii");
  buffer.write(label, 16, "utf8");
  return buffer;
}

test("project cannot adopt or render another project's uploaded audio", async () => {
  const projectA = service.createProject({ title: "Audio owner A" });
  const projectB = service.createProject({ title: "Audio attacker B" });
  const audioA = await createProjectAudioAsset({
    projectId: projectA.id,
    buffer: fakeMp3("owner-a"),
    mimeType: "audio/mpeg"
  });
  assert.equal(listProjectAudioAssets(projectA.id)[0].state, "STAGED");

  service.updateProjectVideo({
    projectId: projectA.id,
    enabled: true,
    settings: { audioUrl: audioA.url }
  });
  assert.equal(listProjectAudioAssets(projectA.id)[0].state, "REFERENCED");

  assert.throws(
    () => service.updateProjectVideo({
      projectId: projectB.id,
      enabled: true,
      settings: { audioUrl: audioA.url }
    }),
    error => error.code === "AUDIO_NOT_OWNED" && error.status === 403
  );
  assert.notEqual(service.getProject(projectB.id).videoSettings.audioUrl, audioA.url);
  assert.deepEqual(listProjectAudioAssets(projectB.id), []);

  await assert.rejects(
    projectAudioFileForProject(projectB.id, audioA.url),
    error => error.code === "AUDIO_NOT_OWNED"
  );
  await assert.rejects(
    audioDataUrl({ id: projectB.id, videoSettings: { audioUrl: audioA.url } }, []),
    error => error.code === "AUDIO_NOT_OWNED"
  );
});

test("historical project audio remains referenced and readable after switching then restoring a version", async () => {
  const project = service.createProject({ title: "Audio versions" });
  const audioA = await createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("version-a"),
    mimeType: "audio/mpeg"
  });
  service.updateProjectVideo({
    projectId: project.id,
    enabled: true,
    settings: { audioUrl: audioA.url }
  });

  const versionA = db.prepare(`SELECT id,snapshot FROM project_versions WHERE project_id=? ORDER BY created_at DESC`)
    .all(project.id)
    .find(row => JSON.parse(row.snapshot).videoSettings?.audioUrl === audioA.url);
  assert.ok(versionA?.id);

  const audioB = await createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("version-b"),
    mimeType: "audio/mpeg"
  });
  service.updateProjectVideo({
    projectId: project.id,
    enabled: true,
    settings: { audioUrl: audioB.url }
  });
  assert.equal(listProjectAudioAssets(project.id).length, 2);
  assert.ok(listProjectAudioAssets(project.id).every(row => row.state === "REFERENCED"));

  const old = new Date(Date.now() - 30 * 864e5);
  await fs.utimes(audioA.absolutePath, old, old);
  await purgeOrphanedProjectAudio({ orphanGraceMs: 0, stagedGraceMs: 0 });
  assert.equal((await fs.stat(audioA.absolutePath)).isFile(), true);

  const restored = service.restoreProjectVersion(project.id, versionA.id);
  assert.equal(restored.videoSettings.audioUrl, audioA.url);
  const dataUrl = await audioDataUrl(restored, []);
  assert.match(dataUrl, /^data:audio\/mpeg;base64,/u);
});

test("unused staged upload is not touched and cleanup removes its file and database row", async () => {
  const project = service.createProject({ title: "Unused staged audio" });
  const staged = await createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("staged"),
    mimeType: "audio/mpeg"
  });
  const row = listProjectAudioAssets(project.id)[0];
  assert.equal(row.state, "STAGED");

  const old = new Date(Date.now() - 2 * 864e5);
  await fs.utimes(staged.absolutePath, old, old);
  await touchOwnedProjectAudio();
  const afterTouch = await fs.stat(staged.absolutePath);
  assert.ok(afterTouch.mtimeMs < Date.now() - 864e5);

  const deleted = await purgeOrphanedProjectAudio({
    stagedGraceMs: 1000,
    orphanGraceMs: 0,
    now: new Date(row.created_at).getTime() + 1001
  });
  assert.equal(deleted, 1);
  assert.deepEqual(listProjectAudioAssets(project.id), []);
  await assert.rejects(fs.stat(staged.absolutePath), error => error.code === "ENOENT");
});

test("project audio storage cap rejects uploads before writing another file", async () => {
  const project = service.createProject({ title: "Audio storage cap" });
  await createProjectAudioAsset({
    projectId: project.id,
    buffer: fakeMp3("large-a", 1500),
    mimeType: "audio/mpeg"
  });
  await assert.rejects(
    createProjectAudioAsset({
      projectId: project.id,
      buffer: fakeMp3("large-b", 600),
      mimeType: "audio/mpeg"
    }),
    error => error.code === "PROJECT_AUDIO_STORAGE_LIMIT" && error.status === 413
  );
  assert.equal(listProjectAudioAssets(project.id).length, 1);
});

test("idle MCP purge closes transport and server and active sessions are capped per principal", async () => {
  const registry = new McpPrincipalBindings({ ttlMs: 10, maxSessionsPerPrincipal: 2 });
  let transportClosed = 0;
  let serverClosed = 0;
  registry.bind("idle", "key:a", {
    transport: { close: async () => { transportClosed += 1; } },
    server: { close: async () => { serverClosed += 1; } }
  });
  const idle = registry.sessions.get("idle");
  assert.deepEqual(registry.purge(idle.touchedAt + 11), ["idle"]);
  await registry.waitForClosing();
  assert.equal(transportClosed, 1);
  assert.equal(serverClosed, 1);
  assert.equal(registry.sessions.has("idle"), false);

  registry.bind("one", "key:a");
  registry.bind("two", "key:a");
  assert.throws(
    () => registry.reserve("key:a"),
    error => error.code === "MCP_SESSION_LIMIT_REACHED" && error.status === 429
  );

  const otherRelease = registry.reserve("key:b");
  otherRelease();
  const release = new McpPrincipalBindings({ maxSessionsPerPrincipal: 1 }).reserve("key:c");
  assert.throws(
    () => {
      const capped = new McpPrincipalBindings({ maxSessionsPerPrincipal: 1 });
      const first = capped.reserve("key:c");
      try { capped.reserve("key:c"); } finally { first(); }
    },
    error => error.code === "MCP_SESSION_LIMIT_REACHED"
  );
  release();
});
