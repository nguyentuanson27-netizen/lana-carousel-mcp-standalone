import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test,{after} from "node:test";

const tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),"lana-video-analysis-test-"));
process.env.DATABASE_PATH=path.join(tempRoot,"video-analysis.sqlite");
process.env.ASSET_DIRECTORY=path.join(tempRoot,"assets");
process.env.PUBLIC_BASE_URL="https://video-analysis.test";

const service=await import("./video-analysis-service.js");
const {db}=await import("./db.js");

const brief={contentDomain:"fashion",contentGoal:"product_showcase",toneStyle:"humorous",ttsSpeed:1.2};
const validOptions=()=>[
  {optionId:"natural_full",label:"Tự nhiên",segments:[
    {id:"scene-1",start:0,end:4,subtitleText:"Mẫu váy này rất xinh",voiceOverText:"Mẫu váy này rất xinh và giúp vóc dáng trông cân đối hơn",enabled:true},
    {id:"scene-2",start:4,end:8,subtitleText:"Phần eo ôm vừa vặn",voiceOverText:"Phần eo được xử lý vừa vặn nên mặc lên rất gọn gàng",enabled:true}
  ]},
  {optionId:"punchy_short",label:"Bắt nhịp",segments:[
    {id:"scene-1",start:0,end:4,subtitleText:"Mặc là xinh",voiceOverText:"Mặc lên là xinh, dáng gọn ngay",enabled:true},
    {id:"scene-2",start:4,end:8,subtitleText:"Eo gọn tức thì",voiceOverText:"Eo gọn, dáng xinh",enabled:true}
  ]}
];

const settingsRow=db.prepare("SELECT settings_json FROM video_analysis_projects WHERE id=?");
const updateSettings=db.prepare("UPDATE video_analysis_projects SET settings_json=? WHERE id=?");

function createProject(){
  const project=service.createVideoAnalysisProject({title:"Integration test",analysisBrief:brief});
  return service.attachVideoSource({
    projectId:project.id,
    url:"https://cdn.test/source.mp4",
    filename:"source.mp4",
    duration:8
  });
}

function prepareProject(){
  const project=createProject();
  const prepared=service.prepareVideoAnalysisScriptOptions({
    projectId:project.id,
    summary:"Video giới thiệu một mẫu váy.",
    options:validOptions()
  });
  return{project,prepared};
}

function readSettings(projectId){
  return JSON.parse(settingsRow.get(projectId).settings_json);
}

function writeSettings(projectId,settings){
  updateSettings.run(JSON.stringify(settings),projectId);
}

after(async()=>{
  db.close();
  await fs.rm(tempRoot,{recursive:true,force:true});
});

test("prepare persists options and select saves only the chosen validated script",()=>{
  const {project,prepared}=prepareProject();
  const persisted=service.getVideoAnalysisProject(project.id);
  assert.equal(persisted.preparedScriptOptions.id,prepared.preparedOptionsId);
  assert.equal(persisted.preparedScriptOptions.contentHash,prepared.contentHash);

  const saved=service.savePreparedVideoAnalysisScript({
    projectId:project.id,
    preparedOptionsId:prepared.preparedOptionsId,
    selectedOption:"punchy_short",
    settings:{
      ttsEnabled:true,
      ttsSpeed:0.8,
      analysisBrief:{contentDomain:"technology",toneStyle:"serious",ttsSpeed:2},
      selectedScriptOption:"natural_full",
      preparedScriptOptions:{id:"attacker-value"},
      geminiStylePrompt:"Do not use this",
      unknownSetting:true
    }
  });

  const expected=validOptions()[1].segments;
  assert.equal(saved.currentVersion,1);
  assert.equal(saved.selectedScriptOption,"punchy_short");
  assert.equal(saved.preparedScriptOptions,null);
  assert.deepEqual(
    saved.script.segments.map(segment=>({
      id:segment.id,start:segment.start,end:segment.end,
      subtitleText:segment.subtitleText,voiceOverText:segment.voiceOverText,enabled:segment.enabled
    })),
    expected.map(segment=>({
      id:segment.id,start:segment.start,end:segment.end,
      subtitleText:segment.subtitleText,voiceOverText:segment.voiceOverText,enabled:segment.enabled
    }))
  );
  assert.equal(saved.settings.ttsEnabled,true);
  assert.equal(saved.settings.ttsSpeed,brief.ttsSpeed);
  assert.deepEqual(saved.settings.analysisBrief,brief);
  assert.equal(saved.settings.geminiStylePrompt,"Đọc tiếng Việt tự nhiên, hài hước, có nhịp và nhấn đúng punchline.");
  assert.equal(saved.settings.unknownSetting,undefined);
});

test("rejects tampered prepared option content hash",()=>{
  const {project,prepared}=prepareProject();
  const settings=readSettings(project.id);
  settings.preparedScriptOptions.options[0].segments[0].voiceOverText="Nội dung đã bị sửa sau khi prepare";
  writeSettings(project.id,settings);

  assert.throws(
    ()=>service.savePreparedVideoAnalysisScript({
      projectId:project.id,
      preparedOptionsId:prepared.preparedOptionsId,
      selectedOption:"natural_full"
    }),
    error=>error.code==="VIDEO_SCRIPT_OPTIONS_INTEGRITY_ERROR"
  );
});

test("rejects prepared options after project version, brief, or source changes",()=>{
  {
    const {project,prepared}=prepareProject();
    db.prepare("UPDATE video_analysis_projects SET current_version=current_version+1 WHERE id=?").run(project.id);
    assert.throws(
      ()=>service.savePreparedVideoAnalysisScript({projectId:project.id,preparedOptionsId:prepared.preparedOptionsId,selectedOption:"natural_full"}),
      error=>error.code==="VIDEO_SCRIPT_OPTIONS_STALE"
    );
  }

  {
    const {project,prepared}=prepareProject();
    const settings=readSettings(project.id);
    settings.analysisBrief={...settings.analysisBrief,toneStyle:"serious"};
    writeSettings(project.id,settings);
    assert.throws(
      ()=>service.savePreparedVideoAnalysisScript({projectId:project.id,preparedOptionsId:prepared.preparedOptionsId,selectedOption:"natural_full"}),
      error=>error.code==="VIDEO_SCRIPT_OPTIONS_STALE"
    );
  }

  {
    const {project,prepared}=prepareProject();
    service.attachVideoSource({
      projectId:project.id,
      url:"https://cdn.test/replacement.mp4",
      filename:"replacement.mp4",
      duration:9
    });
    assert.throws(
      ()=>service.savePreparedVideoAnalysisScript({projectId:project.id,preparedOptionsId:prepared.preparedOptionsId,selectedOption:"natural_full"}),
      error=>error.code==="VIDEO_SCRIPT_OPTIONS_STALE"
    );
  }
});

test("does not persist options whose only differences are in disabled segments",()=>{
  const project=createProject();
  const options=validOptions();
  options[1].segments[0]=structuredClone(options[0].segments[0]);
  options[0].segments[1].enabled=false;
  options[1].segments[1].enabled=false;
  options[0].segments[1].voiceOverText="Nội dung dài khác biệt nhưng segment đã tắt";
  options[1].segments[1].voiceOverText="Ngắn";

  assert.throws(
    ()=>service.prepareVideoAnalysisScriptOptions({projectId:project.id,summary:"Invalid",options}),
    error=>error.code==="VIDEO_SCRIPT_OPTIONS_TOO_SIMILAR"
  );
  assert.equal(service.getVideoAnalysisProject(project.id).preparedScriptOptions,null);
});
