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

test("approved script save is bound to persisted prepared options",()=>{
  const start=source.indexOf('"save_approved_video_script"');
  const end=source.indexOf('server.tool("list_video_analysis_versions"',start);
  const saveToolSource=source.slice(start,end);
  assert.match(saveToolSource,/prepared_options_id:z\.string\(\)\.uuid\(\)/u);
  assert.match(saveToolSource,/savePreparedVideoAnalysisScript/u);
  assert.doesNotMatch(saveToolSource,/segments\s*:/u);
  assert.doesNotMatch(saveToolSource,/z\.record\(z\.any\(\)\)/u);
});
