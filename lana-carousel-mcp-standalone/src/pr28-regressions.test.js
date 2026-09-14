import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {db} from "./db.js";
import {
  createVideoAnalysisProject,
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

function deleteProject(projectId) {
  db.prepare("DELETE FROM video_analysis_projects WHERE id=?").run(projectId);
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
    const now = new Date().toISOString();
    const jobId = randomUUID();
    db.prepare(`
      INSERT INTO video_analysis_jobs(
        id,project_id,project_version,status,progress,error,output_path,created_at,updated_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(jobId, project.id, versionOne.currentVersion, "READY", 100, null, null, now, now, new Date(Date.now() + 864e5).toISOString());

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
