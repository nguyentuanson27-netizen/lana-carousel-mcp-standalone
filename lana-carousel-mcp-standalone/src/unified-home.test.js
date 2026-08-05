import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicRoot=new URL("../public/",import.meta.url);
const html=fs.readFileSync(new URL("projects.html",publicRoot),"utf8");
const client=fs.readFileSync(new URL("projects.js",publicRoot),"utf8");
const videoRoutes=fs.readFileSync(new URL("./video-analysis-routes.js",import.meta.url),"utf8");
const httpServer=fs.readFileSync(new URL("./http-server.js",import.meta.url),"utf8");

test("unified home is served at root and exposes image and video creation entry points",()=>{
  assert.match(httpServer,/app\.get\("\/"[^\n]+projects\.html/u);
  assert.match(html,/data-create="carousel"/u);
  assert.match(html,/data-create="video"/u);
  assert.match(html,/data-filter="carousel"/u);
  assert.match(html,/data-filter="video"/u);
  assert.match(html,/projects\.js/u);
});

test("unified home loads and creates both project types",()=>{
  assert.match(client,/requestJson\("\/api\/projects"\)/u);
  assert.match(client,/requestJson\("\/api\/video-analysis\/projects"\)/u);
  assert.match(client,/method:"POST"/u);
  assert.match(client,/\/video-studio\?projectId=/u);
  assert.match(client,/\/widget\?projectId=/u);
});

test("video projects can be deleted from the shared dashboard",()=>{
  assert.match(client,/\/api\/video-analysis\/projects\/\$\{encodeURIComponent\(id\)\}/u);
  assert.match(videoRoutes,/videoAnalysisRouter\.delete\("\/projects\/:id"/u);
  assert.match(videoRoutes,/deleteVideoAnalysisProject/u);
});
