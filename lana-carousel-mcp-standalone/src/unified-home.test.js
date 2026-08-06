import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const publicRoot=new URL("../public/",import.meta.url);
const html=fs.readFileSync(new URL("projects.html",publicRoot),"utf8");
const client=fs.readFileSync(new URL("projects.js",publicRoot),"utf8");
const videoRoutes=fs.readFileSync(new URL("./video-analysis-routes.js",import.meta.url),"utf8");
const httpServer=fs.readFileSync(new URL("./http-server.js",import.meta.url),"utf8");

test("unified home is served at root and exposes image and video entry points",()=>{
 assert.match(httpServer,/app\.get\("\/"[^\n]+projects\.html/u);
 assert.match(html,/data-create="carousel"/u);
 assert.match(html,/data-create="video"/u);
 assert.match(html,/data-filter="carousel"/u);
 assert.match(html,/data-filter="video"/u);
 assert.match(html,/src="\/projects\.js/u);
});

test("dashboard loads the tested API module and has persistent retry states",()=>{
 assert.match(client,/await import\("\/projects-api\.js"\)/u);
 assert.match(client,/Cả dịch vụ ảnh và video đều không phản hồi/u);
 assert.match(client,/Danh sách chưa đầy đủ/u);
 assert.match(client,/data-action="retry"/u);
 assert.match(client,/Dữ liệu chưa được xác nhận là trống/u);
});

test("video deletion route is connected to lifecycle-aware service cleanup",()=>{
 assert.match(videoRoutes,/videoAnalysisRouter\.delete\("\/projects\/:id"/u);
 assert.match(videoRoutes,/await deleteVideoAnalysisProject/u);
});
