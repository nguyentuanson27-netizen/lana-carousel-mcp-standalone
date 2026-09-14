import assert from "node:assert/strict";
import test from "node:test";
import { calculateSegmentWordTimings, loadSfxDataUrls } from "./video-analysis-jobs.js";
import { VIDEO_EDITABLE_SETTING_KEYS } from "./video-analysis-brief.js";

test("calculateSegmentWordTimings divides duration proportionally across words", () => {
  const text = "Áo dài La Sen thêu tay thủ công";
  const speechDur = 2.0;
  const words = calculateSegmentWordTimings(text, speechDur);

  assert.equal(words.length, 8);
  assert.equal(words[0].word, "Áo");
  assert.equal(words[0].start, 0);
  assert.equal(words[words.length - 1].word, "công");
  assert.equal(words[words.length - 1].end, speechDur);

  // Mọi từ kế tiếp đều bắt đầu ngay khi từ trước kết thúc
  for (let i = 1; i < words.length; i++) {
    assert.equal(words[i].start, words[i - 1].end);
    assert.ok(words[i].end > words[i].start);
  }
});

test("calculateSegmentWordTimings handles empty or invalid inputs gracefully", () => {
  assert.deepEqual(calculateSegmentWordTimings("", 2.5), []);
  assert.deepEqual(calculateSegmentWordTimings("Xin chào", 0), []);
  assert.deepEqual(calculateSegmentWordTimings("Xin chào", -1), []);
  assert.deepEqual(calculateSegmentWordTimings(null, 2.5), []);
});

test("loadSfxDataUrls returns base64 WAV data URLs for all sound effects", async () => {
  const sfx = await loadSfxDataUrls();
  assert.ok(sfx);
  for (const name of ["whoosh", "pop", "ding", "camera"]) {
    assert.ok(sfx[name], `sfx.${name} should be loaded`);
    assert.ok(sfx[name].startsWith("data:audio/wav;base64,"), `sfx.${name} should be a valid wav data URL`);
    assert.ok(sfx[name].length > 500, `sfx.${name} should contain real audio data`);
  }
});

test("VIDEO_EDITABLE_SETTING_KEYS includes all new video enhancement keys", () => {
  const expectedKeys = [
    "subtitlePreset", "ctaEnabled", "ctaType", "ctaText", "ctaPosition",
    "sfxEnabled", "sfxVolume", "sfxPreset"
  ];
  for (const key of expectedKeys) {
    assert.ok(VIDEO_EDITABLE_SETTING_KEYS.includes(key), `Expected ${key} in VIDEO_EDITABLE_SETTING_KEYS`);
  }
});
