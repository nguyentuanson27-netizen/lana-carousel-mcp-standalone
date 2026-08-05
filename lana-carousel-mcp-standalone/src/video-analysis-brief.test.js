import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateVideoScriptOptions,
  normalizeVideoAnalysisBrief,
  sanitizeVideoAnalysisEditableSettings,
  VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";

const brief={contentDomain:"fashion",toneStyle:"humorous",ttsSpeed:1.2};
const validOptions=()=>[
  {optionId:"natural_full",label:"Tự nhiên",segments:[
    {id:"scene-1",start:0,end:4,subtitleText:"Mẫu váy này rất xinh",voiceOverText:"Mẫu váy này rất xinh và giúp vóc dáng trông cân đối hơn"},
    {id:"scene-2",start:4,end:8,subtitleText:"Phần eo ôm vừa vặn",voiceOverText:"Phần eo được xử lý vừa vặn nên mặc lên rất gọn gàng"}
  ]},
  {optionId:"punchy_short",label:"Bắt nhịp",segments:[
    {id:"scene-1",start:0,end:4,subtitleText:"Mặc là xinh",voiceOverText:"Mặc lên là xinh, dáng gọn ngay"},
    {id:"scene-2",start:4,end:8,subtitleText:"Eo gọn tức thì",voiceOverText:"Eo gọn, dáng xinh"}
  ]}
];

test("supports all approved TTS speeds including x1.8 and x2",()=>{
  assert.deepEqual(VIDEO_TTS_SPEEDS,[0.8,1,1.2,1.5,1.8,2]);
  for(const ttsSpeed of VIDEO_TTS_SPEEDS){
    assert.equal(normalizeVideoAnalysisBrief({contentDomain:"fashion",toneStyle:"humorous",ttsSpeed}).ttsSpeed,ttsSpeed);
  }
});

test("rejects unsupported TTS speed",()=>{
  assert.throws(
    ()=>normalizeVideoAnalysisBrief({contentDomain:"fashion",toneStyle:"humorous",ttsSpeed:1.7}),
    error=>error.code==="INVALID_VIDEO_TTS_SPEED"
  );
});

test("requires non-empty aligned and distinct natural_full and punchy_short options",()=>{
  const result=evaluateVideoScriptOptions({brief,options:validOptions()});
  assert.equal(result.options.length,2);
  assert.equal(result.options[0].segments[0].maxWords,10);
  assert.equal(result.options[1].fitsTimeline,true);

  const empty=validOptions();
  empty[0].segments=[];
  empty[1].segments=[];
  assert.throws(()=>evaluateVideoScriptOptions({brief,options:empty}),error=>error.code==="EMPTY_VIDEO_SCRIPT_OPTION");

  const mismatched=validOptions();
  mismatched[1].segments[1].start=4.5;
  assert.throws(()=>evaluateVideoScriptOptions({brief,options:mismatched}),error=>error.code==="VIDEO_SCRIPT_TIMELINE_MISMATCH");

  const identical=validOptions();
  identical[1].segments=structuredClone(identical[0].segments);
  assert.throws(()=>evaluateVideoScriptOptions({brief,options:identical}),error=>error.code==="VIDEO_SCRIPT_OPTIONS_TOO_SIMILAR");
});

test("whitelists editable settings and drops server-managed fields",()=>{
  assert.deepEqual(
    sanitizeVideoAnalysisEditableSettings({ttsEnabled:true,subtitleSize:60,analysisBrief:{ttsSpeed:2},selectedScriptOption:"punchy_short",preparedScriptOptions:{id:"x"},unknown:true}),
    {ttsEnabled:true,subtitleSize:60}
  );
});
