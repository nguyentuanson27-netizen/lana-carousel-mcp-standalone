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
