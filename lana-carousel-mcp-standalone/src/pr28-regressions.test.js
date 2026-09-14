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

test("latest render job ignores a READY artifact from an older project version", () => {
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
        id,project_id,status,progress,error,output_path,created_at,updated_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(jobId, project.id, "READY", 100, null, null, now, now, new Date(Date.now() + 864e5).toISOString());

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
  const briefSource = fs.readFileSync(new URL("./video-analysis-brief.js", import.meta.url), "utf8");
  const mcpSource = fs.readFileSync(new URL("./mcp-tools.js", import.meta.url), "utf8");
  assert.doesNotMatch(briefSource, /["']sfxPreset["']/u);
  assert.doesNotMatch(mcpSource, /\bsfxPreset\b/u);
});

test("guide names only MCP tools that are actually registered", () => {
  const guide = fs.readFileSync(new URL("../public/guide.html", import.meta.url), "utf8");
  assert.match(guide, /<code>add_slide<\/code>/u);
  assert.match(guide, /<code>start_video_analysis_render<\/code>/u);
  for (const nonexistentTool of ["create_slide", "render_video_analysis", "publish_to_facebook", "publish_to_instagram"]) {
    assert.doesNotMatch(guide, new RegExp(`<code>${nonexistentTool}<\\/code>`, "u"));
  }
});
