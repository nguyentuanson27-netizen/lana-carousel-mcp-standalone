import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"lana-media-followup-"));
const keyA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const keyB="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
process.env.NODE_ENV="test";
process.env.API_KEYS=`${keyA},${keyB}`;
process.env.API_DAILY_MUTATION_QUOTA="100";
process.env.API_DAILY_HEAVY_QUOTA="100";
process.env.DATABASE_PATH=path.join(root,"lana.sqlite");
process.env.ASSET_DIRECTORY=path.join(root,"assets");
process.env.PUBLIC_BASE_URL="http://127.0.0.1:8787";
await fs.mkdir(process.env.ASSET_DIRECTORY,{recursive:true});

const service=await import("./service.js");
const videoService=await import("./video-analysis-service.js");
const {sql}=await import("./db.js");
const {apiSecurity}=await import("./api-security.js");
const {
 createProjectAccessUrl,
 createVideoAnalysisAccessUrl,
 exchangeResourceAccessToken
}=await import("./project-access.js");
const {createSignedMediaUrl}=await import("./media-access.js");
const {publicError}=await import("./errors.js");

class FakeResponse extends EventEmitter{
 constructor(){super();this.statusCode=200;this.headers={};this.body=null;this.ended=false;}
 setHeader(name,value){this.headers[String(name).toLowerCase()]=value;return this;}
 getHeader(name){return this.headers[String(name).toLowerCase()];}
 status(code){this.statusCode=code;return this;}
 json(body){this.body=body;this.ended=true;return this;}
 end(){this.ended=true;return this;}
 redirect(code,url){this.statusCode=code;this.redirectedTo=url;this.ended=true;return this;}
}

function fakeRequest(url,{method="GET",cookie="",headers={}}={}){
 return{
  method,url,originalUrl:url,
  headers:{...headers,...(cookie?{cookie}:{})},
  ip:"127.0.0.1",socket:{remoteAddress:"127.0.0.1"}
 };
}

function runSecurity(req){
 const res=new FakeResponse();
 let nextCalled=false;
 apiSecurity(req,res,()=>{nextCalled=true;});
 return{res,nextCalled};
}

function tokenFrom(url){
 return new URLSearchParams(new URL(url).hash.replace(/^#/u,"")).get("access_token");
}

function insertAsset({id,projectId,sha,storageKey=`${id}.webp`}){
 const createdAt=new Date().toISOString();
 sql.createAsset.run({
  id,project_id:projectId,storage_key:storageKey,
  public_url:`${process.env.PUBLIC_BASE_URL}/assets/${storageKey}`,
  mime_type:"image/webp",file_size:10,width:10,height:10,sha256:sha,
  source_image_url:`https://cdn.example.com/${storageKey}`,
  source_page_url:null,source_title:null,source_publisher:null,
  source_type:"unknown",alt_text:null,created_at:createdAt
 });
 return storageKey;
}

test("project grants protect real media and signed render URLs expire at the boundary",()=>{
 const carouselA=service.createProject({title:"Media A"});
 const carouselB=service.createProject({title:"Media B"});
 const assetName=insertAsset({id:randomUUID(),projectId:carouselA.id,sha:"media-a"});

 const sessionA=exchangeResourceAccessToken(tokenFrom(createProjectAccessUrl(carouselA.id)),"carousel",carouselA.id);
 const sessionB=exchangeResourceAccessToken(tokenFrom(createProjectAccessUrl(carouselB.id)),"carousel",carouselB.id);

 const anonymous=runSecurity(fakeRequest(`/assets/${assetName}`));
 assert.equal(anonymous.nextCalled,false);
 assert.equal(anonymous.res.statusCode,401);

 const allowed=runSecurity(fakeRequest(`/assets/${assetName}`,{
  cookie:`lana_resource_session=${sessionA.sessionToken}`
 }));
 assert.equal(allowed.nextCalled,true);
 assert.equal(allowed.res.headers["cache-control"],"private, no-store");

 const denied=runSecurity(fakeRequest(`/assets/${assetName}`,{
  cookie:`lana_resource_session=${sessionB.sessionToken}`
 }));
 assert.equal(denied.nextCalled,false);
 assert.equal(denied.res.statusCode,403);

 const sourceName=`${randomUUID()}.mp4`;
 const video=videoService.createVideoAnalysisProject({
  title:"Protected video",
  sourceUrl:`${process.env.PUBLIC_BASE_URL}/video-analysis-assets/${sourceName}`,
  sourceFilename:"source.mp4",sourceMime:"video/mp4",sourceSize:100
 });
 const videoSession=exchangeResourceAccessToken(
  tokenFrom(createVideoAnalysisAccessUrl(video.id)),"video-analysis",video.id
 );
 const videoAllowed=runSecurity(fakeRequest(`/video-analysis-assets/${sourceName}`,{
  cookie:`lana_resource_session=${videoSession.sessionToken}`
 }));
 assert.equal(videoAllowed.nextCalled,true);

 const signed=createSignedMediaUrl(
  `${process.env.PUBLIC_BASE_URL}/video-analysis-assets/tts-${randomUUID()}.wav`,
  {resourceType:"video-analysis",resourceId:video.id,ttlSeconds:60}
 );
 assert.equal(runSecurity(fakeRequest(signed)).nextCalled,true);
 const tampered=new URL(signed);tampered.searchParams.set("media_id",randomUUID());
 assert.equal(runSecurity(fakeRequest(tampered.toString())).res.statusCode,401);
});

test("candidate trigger keeps concurrent imports at ten and cleans the rejected file",async()=>{
 const project=service.createProject({title:"Concurrent candidates"});
 const slide=service.addSlide({projectId:project.id,position:1,subject:"Look",headline:"Look",body:"Body"});
 const timestamp=new Date().toISOString();
 for(let index=0;index<9;index+=1){
  const id=randomUUID();
  insertAsset({id,projectId:project.id,sha:`seed-${index}`});
  sql.addCandidate.run(slide.id,id,timestamp);
 }

 let started=0;
 let release;
 let markStarted;
 const gate=new Promise(resolve=>{release=resolve;});
 const bothStarted=new Promise(resolve=>{markStarted=resolve;});
 const files=[];
 const importer=label=>async()=>{
  started+=1;
  if(started===2)markStarted();
  await gate;
  const storageKey=`race-${label}.webp`;
  const absolutePath=path.join(process.env.ASSET_DIRECTORY,storageKey);
  await fs.writeFile(absolutePath,label);
  files.push(absolutePath);
  return{
   storageKey,absolutePath,
   publicUrl:`${process.env.PUBLIC_BASE_URL}/assets/${storageKey}`,
   mimeType:"image/webp",fileSize:1,width:1,height:1,
   sha256:`race-${label}`,finalUrl:`https://cdn.example.com/${storageKey}`
  };
 };

 const first=service.importAssetFromUrl({
  projectId:project.id,slideId:slide.id,imageUrl:"https://cdn.example.com/a.webp",
  selectAsset:false,importer:importer("a")
 });
 const second=service.importAssetFromUrl({
  projectId:project.id,slideId:slide.id,imageUrl:"https://cdn.example.com/b.webp",
  selectAsset:false,importer:importer("b")
 });
 await bothStarted;
 release();
 const settled=await Promise.allSettled([first,second]);
 assert.equal(settled.filter(item=>item.status==="fulfilled").length,1);
 const rejected=settled.find(item=>item.status==="rejected");
 assert.equal(publicError(rejected.reason).code,"CANDIDATE_LIMIT_REACHED");
 assert.equal(sql.countCandidates.get(slide.id).count,10);
 const fileStates=await Promise.all(files.map(file=>fs.stat(file).then(()=>true,()=>false)));
 assert.equal(fileStates.filter(Boolean).length,1);
});

test("HTTP MCP session cannot switch API principals",()=>{
 const sessionId=randomUUID();
 const initialized=runSecurity(fakeRequest("/mcp",{
  method:"POST",headers:{"x-api-key":keyA}
 }));
 assert.equal(initialized.nextCalled,true);
 initialized.res.setHeader("mcp-session-id",sessionId);
 initialized.res.emit("finish");

 const wrong=runSecurity(fakeRequest("/mcp",{
  method:"POST",
  headers:{"mcp-session-id":sessionId,"x-api-key":keyB}
 }));
 assert.equal(wrong.nextCalled,false);
 assert.equal(wrong.res.statusCode,403);
 assert.equal(wrong.res.body.code,"MCP_SESSION_PRINCIPAL_MISMATCH");

 const correct=runSecurity(fakeRequest("/mcp",{
  method:"POST",
  headers:{"mcp-session-id":sessionId,"x-api-key":keyA}
 }));
 assert.equal(correct.nextCalled,true);
});
