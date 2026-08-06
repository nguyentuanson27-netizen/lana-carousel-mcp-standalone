import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source=fs.readFileSync(new URL("./mcp-tools.js",import.meta.url),"utf8");

test("MCP composition does not depend on SDK private tool registry",()=>{
  assert.doesNotMatch(source,/_registeredTools/u);
  assert.doesNotMatch(source,/Reflect\.get/u);
  assert.match(source,/registerCarouselTools\(server\)/u);
  assert.match(source,/registerVideoAnalysisTools\(server\)/u);
});

test("current prepared-option approval flow remains integrity-bound",()=>{
  const start=source.indexOf('"save_approved_video_script"');
  const end=source.indexOf('server.tool("list_video_analysis_versions"',start);
  const saveToolSource=source.slice(start,end);
  assert.match(saveToolSource,/prepared_options_id:z\.string\(\)\.uuid\(\)\.optional\(\)/u);
  assert.match(saveToolSource,/savePreparedVideoAnalysisScript/u);
  assert.match(saveToolSource,/VIDEO_MANAGED_SETTINGS_OVERRIDE/u);
  assert.match(saveToolSource,/prepared_options_id.*selected_option.*cùng nhau/su);
});

test("stale schema may create only an unconfigured draft",()=>{
  const start=source.indexOf('"create_video_analysis_project"');
  const end=source.indexOf('server.tool("get_video_analysis_project"',start);
  const createToolSource=source.slice(start,end);
  assert.match(createToolSource,/content_domain:z\.enum\(VIDEO_CONTENT_DOMAINS\)\.optional\(\)/u);
  assert.match(createToolSource,/tone_style:z\.enum\(VIDEO_TONE_STYLES\)\.optional\(\)/u);
  assert.match(createToolSource,/tts_speed:ttsSpeedSchema\.optional\(\)/u);
  assert.match(source,/parseBriefFromArgs/u);
  assert.match(createToolSource,/analysisBrief:briefFromArgs\(args\)/u);
});

test("legacy script payload is draft-only and must preserve brief and selection",()=>{
  const start=source.indexOf('"save_approved_video_script"');
  const end=source.indexOf('server.tool("list_video_analysis_versions"',start);
  const saveToolSource=source.slice(start,end);
  assert.match(saveToolSource,/segments:z\.array\(legacyDraftSegmentSchema\).*\.optional\(\)/su);
  assert.match(source,/VIDEO_LEGACY_DRAFT_ONLY/u);
  assert.match(source,/args\.approved!==false/u);
  assert.match(source,/settings\.analysisBrief/u);
  assert.match(source,/settings\.selectedScriptOption/u);
  assert.match(source,/saveVideoAnalysisScript/u);
});

test("hardening wrappers remain active after stale-schema integration",()=>{
  assert.match(source,/installToolQuota/u);
  assert.match(source,/consumeApiQuota/u);
  assert.match(source,/withStudioAccess/u);
  assert.match(source,/createVideoAnalysisAccessUrl/u);
});

test("MCP version changes when the public tool contract changes",()=>{
  assert.match(source,/version:"1\.7\.0"/u);
});
