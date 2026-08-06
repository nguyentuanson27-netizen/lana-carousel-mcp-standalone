import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test,{after} from "node:test";

const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),"lana-video-lifecycle-test-"));
process.env.DATABASE_PATH=path.join(tempRoot,"video-analysis.sqlite");
process.env.ASSET_DIRECTORY=path.join(tempRoot,"assets");
process.env.PUBLIC_BASE_URL="https://video-lifecycle.test";

const service=await import("./video-analysis-service.js");
const {db}=await import("./db.js");

async function createManagedAsset(name,content=name){
 const absolutePath=path.join(service.videoAnalysisAssetDir,name);
 await fs.writeFile(absolutePath,Buffer.from(content));
 return{
  url:`${process.env.PUBLIC_BASE_URL}/video-analysis-assets/${encodeURIComponent(name)}`,
  filename:name,
  mime:"video/mp4",
  size:Buffer.byteLength(content),
  absolutePath
 };
}

function createProjectWithSource(source,title="Lifecycle test"){
 return service.createVideoAnalysisProject({
  title,
  sourceUrl:source.url,
  sourceFilename:source.filename,
  sourceMime:source.mime,
  sourceSize:source.size,
  duration:8
 });
}

function insertJob({id,projectId,status="QUEUED",outputPath=null}){
 const now=new Date().toISOString();
 db.prepare(`
  INSERT INTO video_analysis_jobs(
   id,project_id,status,progress,error,output_path,created_at,updated_at,expires_at
  ) VALUES(?,?,?,?,?,?,?,?,?)
 `).run(id,projectId,status,status==="RENDERING"?45:0,null,outputPath,now,now,new Date(Date.now()+864e5).toISOString());
}

const restartSource=await createManagedAsset("restart-source.mp4");
const restartProject=createProjectWithSource(restartSource,"Restart recovery");
const interruptedJobId="11111111-1111-4111-8111-111111111111";
const interruptedOutput=path.join(service.videoAnalysisOutputDir,`${interruptedJobId}.mp4`);
await fs.writeFile(interruptedOutput,"partial-render");
insertJob({id:interruptedJobId,projectId:restartProject.id,status:"RENDERING",outputPath:interruptedOutput});

// Importing the worker simulates process startup after persisted active rows already exist.
const jobs=await import("./video-analysis-jobs.js");

function rowForJob(id){
 return db.prepare("SELECT * FROM video_analysis_jobs WHERE id=?").get(id);
}

async function doesNotExist(file){
 await assert.rejects(fs.access(file));
}

after(async()=>{
 db.close();
 await fs.rm(tempRoot,{recursive:true,force:true});
});

test("startup marks persisted queued/rendering jobs failed and removes partial output",async()=>{
 const row=rowForJob(interruptedJobId);
 assert.equal(row.status,"FAILED");
 assert.match(row.error,/khởi động lại/u);
 assert.equal(row.output_path,null);
 await doesNotExist(interruptedOutput);

 const deleted=await service.deleteVideoAnalysisProject(restartProject.id);
 assert.equal(deleted.deleted,true);
});

test("active persisted render job blocks source replacement before download starts",async()=>{
 const source=await createManagedAsset("active-source.mp4");
 const project=createProjectWithSource(source,"Active render guard");
 const jobId="22222222-2222-4222-8222-222222222222";
 insertJob({id:jobId,projectId:project.id,status:"QUEUED"});
 let importerCalled=false;

 await assert.rejects(
  service.attachRemoteVideoSource({
   projectId:project.id,
   url:"https://remote.example/new.mp4",
   importer:async()=>{
    importerCalled=true;
    return createManagedAsset("should-not-download.mp4");
   }
  }),
  error=>error.code==="VIDEO_ANALYSIS_SOURCE_LOCKED"
 );
 assert.equal(importerCalled,false);
 assert.equal(service.getVideoAnalysisProject(project.id).source.url,source.url);

 const recovered=await jobs.recoverInterruptedVideoAnalysisJobs();
 assert.deepEqual(recovered.jobIds,[jobId]);
 await service.deleteVideoAnalysisProject(project.id);
});

test("concurrent remote replacements are serialized and delete the actual replaced source",async()=>{
 const sourceA=await createManagedAsset("source-a.mp4","A");
 const sourceB=await createManagedAsset("source-b.mp4","B");
 const sourceC=await createManagedAsset("source-c.mp4","C");
 const project=createProjectWithSource(sourceA,"Concurrent source replacement");
 const order=[];

 const first=service.attachRemoteVideoSource({
  projectId:project.id,
  url:"https://remote.example/b.mp4",
  importer:async()=>{
   order.push("B:start");
   await new Promise(resolve=>setTimeout(resolve,25));
   order.push("B:end");
   return sourceB;
  }
 });
 await new Promise(resolve=>setTimeout(resolve,5));
 const second=service.attachRemoteVideoSource({
  projectId:project.id,
  url:"https://remote.example/c.mp4",
  importer:async()=>{
   order.push("C:start");
   order.push("C:end");
   return sourceC;
  }
 });

 await Promise.all([first,second]);
 assert.deepEqual(order,["B:start","B:end","C:start","C:end"]);
 assert.equal(service.getVideoAnalysisProject(project.id).source.url,sourceC.url);
 await doesNotExist(sourceA.absolutePath);
 await doesNotExist(sourceB.absolutePath);
 await fs.access(sourceC.absolutePath);
 await service.deleteVideoAnalysisProject(project.id);
});

test("render creation is rejected while a source replacement lock is pending",async()=>{
 const sourceA=await createManagedAsset("lock-source-a.mp4","A");
 const sourceB=await createManagedAsset("lock-source-b.mp4","B");
 const project=createProjectWithSource(sourceA,"Render versus source lock");
 let releaseImport;
 let markImporterStarted;
 const importerStarted=new Promise(resolve=>{markImporterStarted=resolve;});
 const continueImport=new Promise(resolve=>{releaseImport=resolve;});

 const replacement=service.attachRemoteVideoSource({
  projectId:project.id,
  url:"https://remote.example/locked.mp4",
  importer:async()=>{
   markImporterStarted();
   await continueImport;
   return sourceB;
  }
 });
 await importerStarted;
 assert.throws(
  ()=>jobs.startVideoAnalysisJob(project.id),
  error=>error.code==="VIDEO_ANALYSIS_SOURCE_LOCKED"
 );
 releaseImport();
 await replacement;
 await service.deleteVideoAnalysisProject(project.id);
});
