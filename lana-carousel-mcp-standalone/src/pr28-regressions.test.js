import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {db} from "./db.js";
import {
  createVideoAnalysisProject,
  getVideoAnalysisProject,
  saveVideoAnalysisScript
} from "./video-analysis-service.js";
import {getLatestVideoAnalysisJobForProject} from "./video-analysis-jobs.js";

const segment = (text = "Xin chào") => ({
  id: "segment-1",
  start: 0,
  end: 3,
  subtitleText: text,
  voiceOverText: text,
  speaker: "speaker1",
  enabled: true
});

const renderRevision = project => createHash("sha256").update(JSON.stringify({
  projectVersion: Number(project.currentVersion || 0),
  sourceUrl: String(project.source?.url || ""),
  sourceDuration: Number(project.source?.duration || 0)
})).digest("hex");

function deleteProject(projectId) {
  db.prepare("DELETE FROM video_analysis_projects WHERE id=?").run(projectId);
}

function insertReadyJob(project) {
  const now = new Date().toISOString();
  const jobId = randomUUID();
  db.prepare(`
    INSERT INTO video_analysis_jobs(
      id,project_id,project_version,render_revision,status,progress,error,output_path,created_at,updated_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    jobId,
    project.id,
    project.currentVersion,
    renderRevision(project),
    "READY",
    100,
    null,
    null,
    now,
    now,
    new Date(Date.now() + 864e5).toISOString()
  );
  return jobId;
}

test("legacy video-analysis projects keep SFX opt-in instead of enabling it implicitly", () => {
  const project = createVideoAnalysisProject({title: `sfx-default-${randomUUID()}`});
  try {
    assert.equal(project.settings.sfxEnabled, false);
  } finally {
    deleteProject(project.id);
  }
});

test("latest render job is restored only while its project version is current", () => {
  const project = createVideoAnalysisProject({title: `render-version-${randomUUID()}`});
  try {
    const versionOne = saveVideoAnalysisScript({
      projectId: project.id,
      script: {summary: "v1", language: "vi-VN", segments: [segment("Phiên bản một")]},
      approved: true
    });
    const jobId = insertReadyJob(versionOne);

    assert.equal(getLatestVideoAnalysisJobForProject(project.id)?.id, jobId);

    const versionTwo = saveVideoAnalysisScript({
      projectId: project.id,
      script: {summary: "v2", language: "vi-VN", segments: [segment("Phiên bản hai")]},
      approved: true
    });
    assert.equal(versionTwo.currentVersion, versionOne.currentVersion + 1);
    assert.equal(getLatestVideoAnalysisJobForProject(project.id), null);
  } finally {
    deleteProject(project.id);
  }
});

test("latest render job is invalidated when the source changes without a version bump", () => {
  const project = createVideoAnalysisProject({title: `render-source-${randomUUID()}`});
  try {
    const saved = saveVideoAnalysisScript({
      projectId: project.id,
      script: {summary: "source", language: "vi-VN", segments: [segment()]},
      approved: true
    });
    const jobId = insertReadyJob(saved);
    assert.equal(getLatestVideoAnalysisJobForProject(project.id)?.id, jobId);

    db.prepare(`
      UPDATE video_analysis_projects
      SET source_url=?, duration=?, updated_at=?
      WHERE id=?
    `).run(
      "http://localhost/video-analysis-assets/replacement.mp4",
      12.5,
      new Date(Date.now() + 1000).toISOString(),
      project.id
    );

    const changed = getVideoAnalysisProject(project.id);
    assert.equal(changed.currentVersion, saved.currentVersion);
    assert.equal(getLatestVideoAnalysisJobForProject(project.id), null);
  } finally {
    deleteProject(project.id);
  }
});

test("SFX preset is not advertised until it has defined render semantics", () => {
  const sources = [
    "./video-analysis-brief.js",
    "./mcp-tools.js",
    "./video-analysis-routes.js"
  ].map(relativePath => fs.readFileSync(new URL(relativePath, import.meta.url), "utf8"));
  for (const source of sources) assert.doesNotMatch(source, /\bsfxPreset\b/u);
});

test("guide names only MCP tools that are actually registered", () => {
  const guide = fs.readFileSync(new URL("../public/guide.html", import.meta.url), "utf8");
  assert.match(guide, /<code>add_slide<\/code>/u);
  assert.match(guide, /<code>start_video_analysis_render<\/code>/u);
  assert.match(guide, /Không có MCP tool công khai/u);
  assert.doesNotMatch(guide, /<code>create_slide<\/code>/u);
  assert.doesNotMatch(guide, /<code>render_video_analysis<\/code>/u);
  assert.doesNotMatch(guide, /<code>publish_to_facebook<\/code>,\s*<code>publish_to_instagram<\/code>/u);
});
