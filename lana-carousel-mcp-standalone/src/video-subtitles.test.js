import assert from "node:assert/strict";
import test from "node:test";
import { buildSubtitleFile, subtitleCues } from "./video-subtitles.js";

const segments = [
 { id: "b", start: 4.5, end: 7.25, subtitleText: "Đoạn thứ hai", enabled: true },
 { id: "a", start: 0, end: 2.5, subtitleText: "Đoạn đầu tiên", enabled: true },
 { id: "off", start: 8, end: 9, subtitleText: "Đoạn đã tắt", enabled: false },
 { id: "blank", start: 10, end: 11, subtitleText: "   ", enabled: true }
];

test("keeps only enabled cues that have text and orders them by time", () => {
 assert.deepEqual(subtitleCues(segments).map(cue => cue.text), ["Đoạn đầu tiên", "Đoạn thứ hai"]);
});

test("writes SRT with comma milliseconds and one-based indexes", () => {
 assert.equal(buildSubtitleFile(segments, "srt"), [
  "1",
  "00:00:00,000 --> 00:00:02,500",
  "Đoạn đầu tiên",
  "",
  "2",
  "00:00:04,500 --> 00:00:07,250",
  "Đoạn thứ hai",
  ""
 ].join("\n"));
});

test("writes VTT with its header and dot milliseconds", () => {
 const vtt = buildSubtitleFile(segments, "vtt");
 assert.ok(vtt.startsWith("WEBVTT\n\n"));
 assert.ok(vtt.includes("00:00:04.500 --> 00:00:07.250"));
});

test("formats timecodes past an hour", () => {
 const long = [{ start: 3661.5, end: 3663, subtitleText: "Muộn", enabled: true }];
 assert.ok(buildSubtitleFile(long, "srt").includes("01:01:01,500 --> 01:01:03,000"));
});

test("refuses a format it cannot write and a script with nothing to show", () => {
 assert.throws(() => buildSubtitleFile(segments, "ass"), error => error.code === "UNSUPPORTED_SUBTITLE_FORMAT");
 assert.throws(() => buildSubtitleFile([], "srt"), error => error.code === "EMPTY_SUBTITLE_TRACK");
 // Đoạn có thời gian không hợp lệ bị loại, nên không xuất ra tệp phụ đề hỏng.
 assert.throws(
  () => buildSubtitleFile([{ start: 5, end: 5, subtitleText: "Không có độ dài", enabled: true }], "srt"),
  error => error.code === "EMPTY_SUBTITLE_TRACK"
 );
});
