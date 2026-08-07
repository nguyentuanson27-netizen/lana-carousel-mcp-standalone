import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {safeReturnTo} from "../public/safe-return.js";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"lana-review-followup-"));
process.env.NODE_ENV="test";
process.env.API_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_DAILY_MUTATION_QUOTA="2";
process.env.API_DAILY_HEAVY_QUOTA="1";
process.env.DATABASE_PATH=path.join(root,"lana.sqlite");
process.env.ASSET_DIRECTORY=path.join(root,"assets");
process.env.PUBLIC_BASE_URL="http://127.0.0.1:8787";
await fs.mkdir(process.env.ASSET_DIRECTORY,{recursive:true});

const service=await import("./service.js");
const videoService=await import("./video-analysis-service.js");
const {db,sql}=await import("./db.js");
const {
 createBrowserAdminSession,
 createProjectAccessUrl,
 createVideoAnalysisAccessUrl,
 exchangeResourceAccessToken,
 getBrowserAdminSession,
 getResourceSession,
 getResourceSessionGrant,
 listResourceSessionGrants
}=await import("./project-access.js");
const {apiSecurity,shouldProtect}=await import("./api-security.js");
const {consumeApiQuota}=await import("./api-quota.js");
const {runWithQuotaPrincipal}=await import("./quota-principal.js");
const {quotaPolicyForTool}=await import("./mcp-tools.js");

function fakeResponse(){
 return{
  statusCode:200,headers:{},body:null,ended:false,redirectedTo:"",
  setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},
  status(code){this.statusCode=code;return this;},
  json(body){this.body=body;this.ended=true;return this;},
  end(){this.ended=true;return this;},
  redirect(code,url){this.statusCode=code;this.redirectedTo=url;this.ended=true;return this;}
 };
}

function fakeRequest(url,{method="GET",cookie="",headers={}}={}){
 return{
  method,url,originalUrl:url,headers:{...headers,...(cookie?{cookie}:{})},
  ip:"127.0.0.1",socket:{remoteAddress:"127.0.0.1"}
 };
}

function runSecurity(req){
 const res=fakeResponse();
 let nextCalled=false;
 apiSecurity(req,res,()=>{nextCalled=true;});
 return{req,res,nextCalled};
}

function accessTokenFrom(url){
 const parsed=new URL(url);
 return new URLSearchParams(parsed.hash.replace(/^#/u,"")).get("access_token");
}

function insertAsset({id,projectId,sha}){
 const createdAt=new Date().toISOString();
 sql.createAsset.run({
  id,project_id:projectId,storage_key:`${id}.webp`,
  public_url:`http://127.0.0.1:8787/assets/${id}.webp`,
  mime_type:"image/webp",file_size:10,width:10,height:10,sha256:sha,
  source_image_url:`https://cdn.example.com/${id}.webp`,
  source_page_url:null,source_title:null,source_publisher:null,
  source_type:"unknown",alt_text:null,created_at:createdAt
 });
}

test("auth protects case variants and trailing slashes",()=>{
 for(const url of ["/API/projects","/Api/projects","/MCP","/mcp/","/mcp////?x=1"]){
  assert.equal(shouldProtect(fakeRequest(url)),true,`should protect ${url}`);
 }
 assert.equal(shouldProtect(fakeRequest("/health")),false);
});

test("return targets stay on the expected same-origin route",()=>{
 const origin="https://content.lanadesign.tech";
 assert.equal(safeReturnTo("/projects",origin,["/","/projects"],"/"),"/projects");
 assert.equal(safeReturnTo("/video-studio?projectId=abc",origin,["/video-studio"],"/"),"/video-studio?projectId=abc");
 for(const candidate of ["//evil.example","https://evil.example/x","/%5Cevil.example","/\\evil.example","/%255Cevil.example"]){
  assert.equal(safeReturnTo(candidate,origin,["/","/projects","/widget","/video-studio"],"/"),"/",candidate);
 }
});

test("browser admin and multi-grant resource sessions keep production UIs usable",()=>{
 const carouselA=service.createProject({title:"Carousel A"});
 const carouselB=service.createProject({title:"Carousel B"});
 const video=videoService.createVideoAnalysisProject({title:"Video auth"});
 const principal="key:stable-review-principal";

 const dashboardRedirect=runSecurity(fakeRequest("/PROJECTS/"));
 assert.equal(dashboardRedirect.nextCalled,false);
 assert.equal(dashboardRedirect.res.statusCode,302);
 assert.match(dashboardRedirect.res.redirectedTo,/admin-auth\.html/u);

 const admin=createBrowserAdminSession(principal);
 assert.equal(getBrowserAdminSession(admin.sessionToken).quota_client_id,principal);
 const dashboard=runSecurity(fakeRequest("/API/projects",{cookie:`lana_admin_session=${admin.sessionToken}`}));
 assert.equal(dashboard.nextCalled,true);
 assert.equal(dashboard.req.apiClientId,principal);

 const videoUrl=runWithQuotaPrincipal(principal,()=>createVideoAnalysisAccessUrl(video.id));
 const videoToken=accessTokenFrom(videoUrl);
 const exchanged=exchangeResourceAccessToken(videoToken,"video-analysis",video.id);
 const stored=getResourceSession(exchanged.sessionToken);
 assert.equal(getResourceSessionGrant(stored,"video-analysis",video.id).quota_client_id,principal);
 assert.throws(
  ()=>exchangeResourceAccessToken(videoToken,"video-analysis",video.id),
  error=>error.code==="ACCESS_TOKEN_INVALID"
 );

 const carouselAToken=accessTokenFrom(runWithQuotaPrincipal(principal,()=>createProjectAccessUrl(carouselA.id)));
 const sameSessionA=exchangeResourceAccessToken(carouselAToken,"carousel",carouselA.id,exchanged.sessionToken);
 assert.equal(sameSessionA.sessionToken,exchanged.sessionToken);
 const carouselBToken=accessTokenFrom(runWithQuotaPrincipal(principal,()=>createProjectAccessUrl(carouselB.id)));
 const sameSessionB=exchangeResourceAccessToken(carouselBToken,"carousel",carouselB.id,exchanged.sessionToken);
 assert.equal(sameSessionB.sessionToken,exchanged.sessionToken);
 assert.equal(listResourceSessionGrants(getResourceSession(exchanged.sessionToken)).length,3);

 for(const projectId of [carouselA.id,carouselB.id]){
  const access=runSecurity(fakeRequest(`/api/projects/${projectId}`,{
   cookie:`lana_resource_session=${exchanged.sessionToken}`
  }));
  assert.equal(access.nextCalled,true);
  assert.equal(access.req.apiClientId,principal);
 }

 const projectAccess=runSecurity(fakeRequest(`/API/video-analysis/projects/${video.id}`,{
  cookie:`lana_resource_session=${exchanged.sessionToken}`
 }));
 assert.equal(projectAccess.nextCalled,true);
 assert.equal(projectAccess.req.apiClientId,principal);

 const listDenied=runSecurity(fakeRequest("/api/video-analysis/projects",{
  cookie:`lana_resource_session=${exchanged.sessionToken}`
 }));
 assert.equal(listDenied.nextCalled,false);
 assert.equal(listDenied.res.statusCode,401);

 const jobId=randomUUID();
 const timestamp=new Date().toISOString();
 db.prepare(`INSERT INTO video_analysis_jobs(id,project_id,status,progress,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?)`)
  .run(jobId,video.id,"READY",100,timestamp,timestamp,new Date(Date.now()+864e5).toISOString());
 const jobAccess=runSecurity(fakeRequest(`/api/video-analysis/jobs/${jobId}/download`,{
  cookie:`lana_resource_session=${exchanged.sessionToken}`
 }));
 assert.equal(jobAccess.nextCalled,true);
 assert.equal(jobAccess.req.apiClientId,principal);
});

test("MCP quota policy charges token issuance and distinguishes heavy operations",()=>{
 assert.deepEqual(quotaPolicyForTool("get_project",{}),{mutations:1,heavy:0});
 assert.deepEqual(quotaPolicyForTool("get_project_link",{}),{mutations:1,heavy:0});
 assert.deepEqual(quotaPolicyForTool("get_video_analysis_project",{}),{mutations:1,heavy:0});
 assert.deepEqual(quotaPolicyForTool("list_projects",{}),{mutations:0,heavy:0});
 assert.deepEqual(quotaPolicyForTool("update_slide_content",{}),{mutations:1,heavy:0});
 assert.deepEqual(quotaPolicyForTool("render_project",{}),{mutations:1,heavy:1});
 assert.deepEqual(quotaPolicyForTool("create_video_analysis_project",{}),{mutations:1,heavy:0});
 assert.deepEqual(quotaPolicyForTool("create_video_analysis_project",{source_url:"https://cdn.example.com/video.mp4"}),{mutations:1,heavy:1});

 consumeApiQuota("quota-test",{mutations:1,heavy:1});
 assert.throws(
  ()=>consumeApiQuota("quota-test",{mutations:1,heavy:1}),
  error=>error.code==="HEAVY_QUOTA_EXCEEDED"
 );
});

test("duplicate candidate at the 10-image limit stays a no-op and preserves approval",async()=>{
 const project=service.createProject({title:"Duplicate at limit"});
 const slide=service.addSlide({
  projectId:project.id,position:1,subject:"Look",headline:"Look",body:"Body"
 });
 for(let index=0;index<10;index+=1){
  const id=`asset-limit-${index}`;
  insertAsset({id,projectId:project.id,sha:`hash-limit-${index}`});
  sql.addCandidate.run(slide.id,id,new Date().toISOString());
 }
 service.approveProjectContent(project.id);
 service.approveSlideAssets({
  projectId:project.id,slideId:slide.id,assetIds:["asset-limit-4"],mode:"crop"
 });

 const duplicatePath=path.join(root,"duplicate-download.webp");
 await fs.writeFile(duplicatePath,"duplicate");
 const duplicate=await service.importAssetFromUrl({
  projectId:project.id,
  slideId:slide.id,
  imageUrl:"https://cdn.example.com/duplicate.webp",
  selectAsset:false,
  importer:async()=>({
   storageKey:"duplicate-download.webp",absolutePath:duplicatePath,
   publicUrl:"http://127.0.0.1:8787/assets/duplicate-download.webp",
   mimeType:"image/webp",fileSize:9,width:10,height:10,
   sha256:"hash-limit-4",finalUrl:"https://cdn.example.com/duplicate.webp"
  })
 });
 assert.equal(duplicate.candidateAdded,false);
 assert.equal(duplicate.candidateCount,10);
 assert.equal(await fs.stat(duplicatePath).then(()=>true).catch(()=>false),false);
 const approved=service.getProject(project.id);
 assert.equal(approved.imageStatus,"APPROVED");
 assert.equal(approved.slides[0].imageApproved,true);

 const newPath=path.join(root,"new-download.webp");
 await fs.writeFile(newPath,"new");
 await assert.rejects(
  service.importAssetFromUrl({
   projectId:project.id,
   slideId:slide.id,
   imageUrl:"https://cdn.example.com/new.webp",
   selectAsset:false,
   importer:async()=>({
    storageKey:"new-download.webp",absolutePath:newPath,
    publicUrl:"http://127.0.0.1:8787/assets/new-download.webp",
    mimeType:"image/webp",fileSize:3,width:10,height:10,
    sha256:"hash-new-at-limit",finalUrl:"https://cdn.example.com/new.webp"
   })
  }),
  error=>error.code==="CANDIDATE_LIMIT_REACHED"
 );
 assert.equal(await fs.stat(newPath).then(()=>true).catch(()=>false),false);
 assert.equal(sql.countCandidates.get(slide.id).count,10);
});
