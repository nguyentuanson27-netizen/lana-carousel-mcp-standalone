import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateVideoScriptOptions,
  normalizeVideoAnalysisBrief,
  VIDEO_TTS_SPEEDS
} from "./video-analysis-brief.js";

test("supports all approved TTS speeds including x1.8 and x2", () => {
  assert.deepEqual(VIDEO_TTS_SPEEDS, [0.8, 1, 1.2, 1.5, 1.8, 2]);
  for (const ttsSpeed of VIDEO_TTS_SPEEDS) {
    assert.equal(normalizeVideoAnalysisBrief({contentDomain:"fashion", toneStyle:"humorous", ttsSpeed}).ttsSpeed, ttsSpeed);
  }
});

test("rejects unsupported TTS speed", () => {
  assert.throws(
    () => normalizeVideoAnalysisBrief({contentDomain:"fashion", toneStyle:"humorous", ttsSpeed:1.7}),
    error => error.code === "INVALID_VIDEO_TTS_SPEED"
  );
});

test("requires exactly natural_full and punchy_short options", () => {
  const result = evaluateVideoScriptOptions({
    brief:{contentDomain:"fashion", toneStyle:"humorous", ttsSpeed:1.2},
    options:[
      {optionId:"natural_full", label:"Tự nhiên", segments:[{start:0,end:4,subtitleText:"Mẫu váy này rất xinh",voiceOverText:"Mẫu váy này rất xinh và tôn dáng"}]},
      {optionId:"punchy_short", label:"Bắt nhịp", segments:[{start:0,end:4,subtitleText:"Mặc là xinh",voiceOverText:"Mặc lên là xinh"}]}
    ]
  });
  assert.equal(result.options.length, 2);
  assert.equal(result.options[0].segments[0].maxWords, 10);
  assert.equal(result.options[1].fitsTimeline, true);
});
