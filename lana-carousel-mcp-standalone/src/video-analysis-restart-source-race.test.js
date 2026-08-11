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

const voiceSegments=[
 {id:"s1",start:0,end:1},
 {id:"s2",start:2.5,end:3.5},
 {id:"s3",start:6,end:8}
];

test("places every voice clip at its own segment start instead of stacking them back to back",()=>{
 const tracks=jobs.planVoiceTracks({
  segments:voiceSegments,
  clips:[
   {url:"a.wav",rawDuration:.8},
   {url:"b.wav",rawDuration:.9},
   {url:"c.wav",rawDuration:1.2}
  ],
  ttsSpeed:1
 });
 assert.deepEqual(tracks.map(track=>track.start),[0,2.5,6]);
 assert.deepEqual(tracks.map(track=>track.id),["s1","s2","s3"]);
 assert.deepEqual(tracks.map(track=>track.playbackRate),[1,1,1]);
 assert.deepEqual(tracks.map(track=>Number(track.duration.toFixed(3))),[.8,.9,1.2]);
});

test("speeds a clip up only far enough to stop it running into the next segment",()=>{
 const [tooLong,fits]=jobs.planVoiceTracks({
  segments:[{id:"s1",start:0,end:2},{id:"s2",start:2,end:4}],
  clips:[{url:"a.wav",rawDuration:2.4},{url:"b.wav",rawDuration:1}],
  ttsSpeed:1
 });
 assert.equal(Number(tooLong.playbackRate.toFixed(3)),1.2);
 assert.equal(Number(tooLong.duration.toFixed(3)),2);
 assert.equal(fits.playbackRate,1);
});

test("caps the catch-up rate so an over-long clip overlaps rather than losing words",()=>{
 const [track]=jobs.planVoiceTracks({
  segments:[{id:"s1",start:0,end:1},{id:"s2",start:1,end:2}],
  clips:[{url:"a.wav",rawDuration:10},null],
  ttsSpeed:1
 });
 assert.equal(track.playbackRate,1.25);
 assert.equal(track.duration,8);
});

test("keeps the reading speed as the baseline playback rate and skips silent segments",()=>{
 const tracks=jobs.planVoiceTracks({
  segments:voiceSegments,
  clips:[{url:"a.wav",rawDuration:1.2},null,{url:"c.wav",rawDuration:1}],
  ttsSpeed:1.2
 });
 assert.deepEqual(tracks.map(track=>track.id),["s1","s3"]);
 assert.deepEqual(tracks.map(track=>track.playbackRate),[1.2,1.2]);
 assert.equal(Number(tracks[0].duration.toFixed(3)),1);
});

function wavFixture({seconds=1,sampleRate=24000,extraChunk=false}={}){
 const data=Buffer.alloc(Math.round(sampleRate*seconds)*2);
 const chunks=[Buffer.from("WAVE","ascii")];
 const fmt=Buffer.alloc(24);
 fmt.write("fmt ",0);
 fmt.writeUInt32LE(16,4);
 fmt.writeUInt16LE(1,8);
 fmt.writeUInt16LE(1,10);
 fmt.writeUInt32LE(sampleRate,12);
 fmt.writeUInt32LE(sampleRate*2,16);
 fmt.writeUInt16LE(2,20);
 fmt.writeUInt16LE(16,22);
 chunks.push(fmt);
 if(extraChunk){
  const list=Buffer.alloc(14);
  list.write("LIST",0);
  list.writeUInt32LE(6,4);
  chunks.push(list.subarray(0,14));
 }
 const header=Buffer.alloc(8);
 header.write("data",0);
 header.writeUInt32LE(data.length,4);
 chunks.push(header,data);
 const body=Buffer.concat(chunks);
 const riff=Buffer.alloc(8);
 riff.write("RIFF",0);
 riff.writeUInt32LE(body.length,4);
 return Buffer.concat([riff,body]);
}

test("measures the real length of a generated wav clip",()=>{
 assert.equal(jobs.wavDurationSeconds(wavFixture({seconds:2.5})),2.5);
 assert.equal(jobs.wavDurationSeconds(wavFixture({seconds:1.25,sampleRate:48000})),1.25);
 assert.equal(jobs.wavDurationSeconds(wavFixture({seconds:.5,extraChunk:true})),.5);
});

test("reports no duration for audio that is not a readable wav",()=>{
 assert.equal(jobs.wavDurationSeconds(Buffer.alloc(0)),0);
 assert.equal(jobs.wavDurationSeconds(Buffer.from("ID3 this is an mp3 payload padded out to be long enough")),0);
});

test("marks a clip with only an estimated duration so it never gets trimmed to that guess",()=>{
 const [estimated,measured]=jobs.planVoiceTracks({
  segments:[{id:"s1",start:0,end:3},{id:"s2",start:4,end:7}],
  clips:[
   {url:"google.mp3",rawDuration:1.4,measured:false},
   {url:"vertex.wav",rawDuration:1.4,measured:true}
  ],
  ttsSpeed:1
 });
 assert.equal(estimated.measured,false);
 assert.equal(measured.measured,true);
});

const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

test("lets in-flight workers finish before surfacing a failure so cleanup sees every temp file",async()=>{
 const written=[];
 const failed=await jobs.mapWithLimit([0,1,2,3],2,async item=>{
  if(item===0){
   await delay(5);
   throw new Error("TTS đoạn 1 hỏng");
  }
  await delay(40);
  written.push(item);
  return item;
 }).then(()=>null,error=>error);

 assert.equal(failed?.message,"TTS đoạn 1 hỏng");
 // Worker chậm phải xong trước khi lỗi nổi lên, nếu không file nó ghi ra sẽ lọt khỏi vòng dọn dẹp.
 assert.deepEqual(written,[1]);
});

test("stops handing out new work once a worker has failed",async()=>{
 const started=[];
 await jobs.mapWithLimit([0,1,2,3,4,5],1,async item=>{
  started.push(item);
  if(item===1)throw new Error("dừng ở đây");
  return item;
 }).catch(()=>{});
 assert.deepEqual(started,[0,1]);
});

test("returns results in the original order when nothing fails",async()=>{
 const results=await jobs.mapWithLimit([30,0,10],3,async item=>{
  await delay(item);
  return `item-${item}`;
 });
 assert.deepEqual(results,["item-30","item-0","item-10"]);
});
