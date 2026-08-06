import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test,{after} from "node:test";

const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),"lana-video-source-test-"));
process.env.DATABASE_PATH=path.join(tempRoot,"video-source.sqlite");
process.env.PUBLIC_BASE_URL="https://video-source.test";

const importer=await import("./video-source-importer.js");

after(async()=>fs.rm(tempRoot,{recursive:true,force:true}));

test("accepts only video-analysis assets on the configured public origin",()=>{
 const managed="https://video-source.test/video-analysis-assets/source.mp4";
 assert.equal(importer.isManagedVideoSourceUrl(managed),true);
 assert.equal(importer.assertManagedVideoSourceUrl(managed),managed);
 assert.equal(importer.isManagedVideoSourceUrl("https://cdn.example.com/source.mp4"),false);
 assert.throws(
  ()=>importer.assertManagedVideoSourceUrl("https://cdn.example.com/source.mp4"),
  error=>error.code==="UNSAFE_VIDEO_SOURCE"
 );
});

test("blocks localhost and private IP video sources before any download",async()=>{
 await assert.rejects(
  importer.importRemoteVideoSource({url:"https://127.0.0.1/video.mp4"}),
  error=>error.code==="SSRF_BLOCKED"
 );
 await assert.rejects(
  importer.importRemoteVideoSource({url:"https://169.254.169.254/latest/meta-data/"}),
  error=>error.code==="SSRF_BLOCKED"
 );
 await assert.rejects(
  importer.importRemoteVideoSource({url:"http://example.com/video.mp4"}),
  error=>error.code==="UNSUPPORTED_PROTOCOL"
 );
});
