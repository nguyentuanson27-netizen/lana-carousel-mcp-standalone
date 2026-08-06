import assert from "node:assert/strict";
import test from "node:test";
import {
 createDashboardProject,
 loadUnifiedProjectSources,
 projectDeleteEndpoint
} from "../public/projects-api.js";

test("loads both project sources and reports partial failures without pretending the workspace is empty",async()=>{
 const calls=[];
 const loaded=await loadUnifiedProjectSources(async url=>{
  calls.push(url);
  if(url==="/api/projects")return{projects:[{id:"image-1"}]};
  throw new Error("video unavailable");
 });
 assert.deepEqual(calls,["/api/projects","/api/video-analysis/projects"]);
 assert.deepEqual(loaded.imageProjects,[{id:"image-1"}]);
 assert.deepEqual(loaded.videoProjects,[]);
 assert.equal(loaded.successCount,1);
 assert.deepEqual(loaded.sources,{carousel:"ready",video:"error"});
 assert.equal(loaded.failures[0].type,"video");
});

test("reports a full failure when both project APIs fail",async()=>{
 const loaded=await loadUnifiedProjectSources(async()=>{throw new Error("offline")});
 assert.equal(loaded.successCount,0);
 assert.deepEqual(loaded.sources,{carousel:"error",video:"error"});
 assert.equal(loaded.failures.length,2);
 assert.deepEqual(loaded.imageProjects,[]);
 assert.deepEqual(loaded.videoProjects,[]);
});

test("creates carousel and video projects through their exact endpoints and POST payloads",async()=>{
 const requests=[];
 const requestJson=async(url,options)=>{
  requests.push({url,options,body:JSON.parse(options.body)});
  return{id:`project-${requests.length}`};
 };
 await createDashboardProject({
  type:"carousel",
  title:"Ảnh mùa thu",
  topic:"Áo dài",
  requestJson
 });
 await createDashboardProject({
  type:"video",
  title:"Video mùa thu",
  sourceUrl:"https://cdn.example.com/lookbook.mp4",
  requestJson
 });
 assert.deepEqual(requests[0],{
  url:"/api/projects",
  options:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:"Ảnh mùa thu",topic:"Áo dài"})},
  body:{title:"Ảnh mùa thu",topic:"Áo dài"}
 });
 assert.equal(requests[1].url,"/api/video-analysis/projects");
 assert.equal(requests[1].options.method,"POST");
 assert.deepEqual(requests[1].body,{
  title:"Video mùa thu",
  sourceUrl:"https://cdn.example.com/lookbook.mp4",
  sourceFilename:"lookbook.mp4"
 });
});

test("builds the correct delete endpoint for each project type",()=>{
 assert.equal(projectDeleteEndpoint("carousel","image id"),"/api/projects/image%20id");
 assert.equal(projectDeleteEndpoint("video","video id"),"/api/video-analysis/projects/video%20id");
});
