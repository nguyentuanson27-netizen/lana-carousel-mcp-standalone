import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {after,before,describe,test} from "node:test";

async function freePort(){
 const probe=net.createServer();
 await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));
 const {port}=probe.address();
 await new Promise(resolve=>probe.close(resolve));
 return port;
}

let chromium=null;
try{({chromium}=await import("playwright"));}catch{chromium=null;}

const tempDirectory=await fs.mkdtemp(path.join(os.tmpdir(),"lana-pr28-download-"));
const PORT=await freePort();
const origin=`http://127.0.0.1:${PORT}`;
const serverEnvironment={
 ...process.env,
 DATABASE_PATH:path.join(tempDirectory,"pr28-download.sqlite"),
 ASSET_DIRECTORY:path.join(tempDirectory,"assets"),
 PORT:String(PORT),
 PUBLIC_BASE_URL:origin
};

let browser=null,skipReason=chromium?false:"chưa cài playwright";
if(chromium){
 const executablePath=process.env.CHROMIUM_PATH;
 try{browser=await chromium.launch(executablePath?{executablePath}:{});}
 catch(error){skipReason=`không mở được Chromium: ${error.message.split("\n")[0]}`;}
}

async function createProjectWithVersion(){
 const created=await fetch(`${origin}/api/video-analysis/projects`,{
  method:"POST",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({title:"PR28 stale download"})
 });
 const project=await created.json();
 const saved=await fetch(`${origin}/api/video-analysis/projects/${project.id}/script`,{
  method:"PUT",
  headers:{"content-type":"application/json"},
  body:JSON.stringify({
   approved:false,
   note:"version one",
   script:{summary:"",language:"vi-VN",segments:[]},
   settings:{}
  })
 });
 assert.equal(saved.status,200);
 return project.id;
}

async function routeLatestJob(page,projectId){
 let calls=0;
 await page.route(`**/api/video-analysis/projects/${projectId}/latest-job`,async route=>{
  calls+=1;
  const job=calls===1?{
   id:"11111111-1111-4111-8111-111111111111",
   projectId,
   status:"READY",
   progress:100,
   error:null,
   downloadUrl:"/api/video-analysis/jobs/11111111-1111-4111-8111-111111111111/download",
   createdAt:new Date().toISOString()
  }:null;
  await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({job})});
 });
}

const queuedJob=(id,projectId)=>({
 id,
 projectId,
 status:"QUEUED",
 progress:0,
 error:null,
 downloadUrl:null,
 createdAt:new Date().toISOString()
});

describe("Video Studio invalidates stale READY downloads",{skip:skipReason},()=>{
 let server;
 before(async()=>{
  server=spawn("node",["src/http-server.js"],{env:serverEnvironment,stdio:["ignore","pipe","pipe"]});
  let ready=false;
  for(let attempt=0;attempt<80&&!ready;attempt+=1){
   try{ready=(await fetch(`${origin}/health`)).ok;}catch{/* server chưa lên */}
   if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready,`server không lên sau 16 giây tại ${origin}`);
 });

 after(async()=>{
  server?.kill();
  await browser?.close();
  await fs.rm(tempDirectory,{recursive:true,force:true});
 });

 test("saving a new project version hides the previous render download",async()=>{
  const projectId=await createProjectWithVersion();
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  await routeLatestJob(page,projectId);
  await page.goto(`${origin}/video-studio?projectId=${projectId}`,{waitUntil:"networkidle"});
  assert.equal(await page.locator("#download").isVisible(),true,"READY job phải hiện nút tải trước khi project đổi");

  const saved=page.waitForResponse(response=>response.url().includes(`/projects/${projectId}/script`)&&response.request().method()==="PUT");
  await page.click("#save");
  assert.equal((await saved).status(),200);
  await page.waitForTimeout(150);

  assert.equal(await page.locator("#download").isVisible(),false,"lưu version mới phải ẩn download của render cũ");
  assert.equal(await page.locator("#download").getAttribute("href"),null,"download cũ không được giữ href sau khi project đổi");
  await page.close();
 });

 test("restoring a project version hides the previous render download when latest-job is stale",async()=>{
  const projectId=await createProjectWithVersion();
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  await routeLatestJob(page,projectId);
  await page.goto(`${origin}/video-studio?projectId=${projectId}`,{waitUntil:"networkidle"});
  assert.equal(await page.locator("#download").isVisible(),true,"READY job phải hiện nút tải trước khi restore");

  await page.waitForSelector("#versions button",{state:"attached"});
  const restored=page.waitForResponse(response=>response.url().includes(`/projects/${projectId}/versions/`)&&response.url().endsWith("/restore")&&response.request().method()==="POST");
  const latest=page.waitForResponse(response=>response.url().endsWith(`/projects/${projectId}/latest-job`)&&response.request().method()==="GET");
  await page.locator("#versions button").first().evaluate(button=>button.click());
  assert.equal((await restored).status(),200);
  assert.equal((await latest).status(),200);
  await page.waitForTimeout(100);

  assert.equal(await page.locator("#download").isVisible(),false,"restore version phải bỏ download không còn khớp revision");
  assert.equal(await page.locator("#download").getAttribute("href"),null,"restore version không được giữ href render cũ");
  await page.close();
 });

 test("a stale in-flight poll cannot cancel the replacement job poll timer",async()=>{
  const projectId=await createProjectWithVersion();
  const page=await browser.newPage({viewport:{width:1500,height:1000}});
  const oldId="11111111-1111-4111-8111-111111111111";
  const newId="22222222-2222-4222-8222-222222222222";
  let latestCalls=0,oldCalls=0,newCalls=0,releaseOldSecond;
  let markOldSecondStarted;
  const oldSecondStarted=new Promise(resolve=>{markOldSecondStarted=resolve});
  const oldSecondRelease=new Promise(resolve=>{releaseOldSecond=resolve});

  await page.route(`**/api/video-analysis/projects/${projectId}/latest-job`,async route=>{
    latestCalls+=1;
    const job=latestCalls===1?queuedJob(oldId,projectId):queuedJob(newId,projectId);
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({job})});
  });
  await page.route(`**/api/video-analysis/jobs/${oldId}`,async route=>{
    oldCalls+=1;
    if(oldCalls>1){
      markOldSecondStarted();
      await oldSecondRelease;
    }
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(queuedJob(oldId,projectId))});
  });
  await page.route(`**/api/video-analysis/jobs/${newId}`,async route=>{
    newCalls+=1;
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(queuedJob(newId,projectId))});
  });

  await page.goto(`${origin}/video-studio?projectId=${projectId}`,{waitUntil:"networkidle"});
  await oldSecondStarted;
  await page.evaluate(()=>load());
  assert.equal(newCalls,1,"replacement poll phải chạy ngay một lần");
  releaseOldSecond();
  await page.waitForTimeout(2300);

  assert.ok(newCalls>=2,"callback poll cũ không được hủy interval của replacement poll");
  await page.close();
 });
});
