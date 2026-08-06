import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test,{after} from "node:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";

const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),"lana-mcp-integration-test-"));
process.env.DATABASE_PATH=path.join(tempRoot,"lana.sqlite");
process.env.ASSET_DIRECTORY=path.join(tempRoot,"assets");
process.env.PUBLIC_BASE_URL="https://mcp-integration.test";

const {createMcpServer}=await import("./mcp-tools.js");
const {db}=await import("./db.js");

after(async()=>{
 db.close();
 await fs.rm(tempRoot,{recursive:true,force:true});
});

function parseToolError(result){
 const text=result.content.find(item=>item.type==="text")?.text||"{}";
 return JSON.parse(text);
}

test("legacy save MCP path persists a draft and rejects approval",async()=>{
 const server=createMcpServer();
 const client=new Client({name:"legacy-save-integration-test",version:"1.0.0"});
 const[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 await server.connect(serverTransport);
 await client.connect(clientTransport);

 try{
  const created=await client.callTool({
   name:"create_video_analysis_project",
   arguments:{title:"Legacy schema integration"}
  });
  assert.notEqual(created.isError,true);
  const project=created.structuredContent;
  assert.equal(project.status,"DRAFT");
  assert.equal(project.analysisBrief,null);

  const legacyArguments={
   project_id:project.id,
   summary:"Video giới thiệu một sản phẩm thời trang.",
   segments:[{
    id:"scene-1",
    start:0,
    end:2,
    subtitle_text:"Quay lưng, spotlight tới ngay.",
    voice_over_text:"Quay lưng, spotlight tới ngay.",
    speaker:"speaker1",
    enabled:true
   }],
   version_note:"Legacy natural_full draft",
   settings:{
    analysisBrief:{
     contentDomain:"fashion",
     contentGoal:"product_showcase",
     toneStyle:"humorous",
     ttsSpeed:1.2
    },
    selectedScriptOption:"natural_full",
    ttsEnabled:true,
    subtitleEnabled:true
   }
  };

  const saved=await client.callTool({
   name:"save_approved_video_script",
   arguments:{...legacyArguments,approved:false}
  });
  assert.notEqual(saved.isError,true);
  const savedProject=saved.structuredContent;
  assert.equal(savedProject.status,"DRAFT");
  assert.equal(savedProject.currentVersion,1);
  assert.equal(savedProject.selectedScriptOption,"natural_full");
  assert.deepEqual(savedProject.analysisBrief,legacyArguments.settings.analysisBrief);
  assert.equal(savedProject.settings.ttsEnabled,true);
  assert.equal(savedProject.settings.subtitleEnabled,true);
  assert.equal(savedProject.settings.preparedScriptOptions,null);
  assert.equal(savedProject.script.segments[0].voiceOverText,"Quay lưng, spotlight tới ngay.");

  const rejected=await client.callTool({
   name:"save_approved_video_script",
   arguments:{...legacyArguments,approved:true}
  });
  assert.equal(rejected.isError,true);
  assert.equal(parseToolError(rejected).code,"VIDEO_LEGACY_DRAFT_ONLY");

  const reloaded=await client.callTool({
   name:"get_video_analysis_project",
   arguments:{project_id:project.id}
  });
  assert.notEqual(reloaded.isError,true);
  assert.equal(reloaded.structuredContent.status,"DRAFT");
  assert.equal(reloaded.structuredContent.currentVersion,1);
 }finally{
  await Promise.allSettled([client.close(),server.close()]);
 }
});
