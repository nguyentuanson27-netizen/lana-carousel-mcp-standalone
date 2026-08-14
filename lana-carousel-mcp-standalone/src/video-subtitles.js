import { AppError } from "./errors.js";

export const SUBTITLE_FORMATS = ["srt", "vtt"];

function timecode(seconds, separator) {
 const total = Math.max(0, Number(seconds) || 0);
 const milliseconds = Math.round(total * 1000);
 const hours = Math.floor(milliseconds / 3600000);
 const minutes = Math.floor(milliseconds % 3600000 / 60000);
 const wholeSeconds = Math.floor(milliseconds % 60000 / 1000);
 const pad = (value, width = 2) => String(value).padStart(width, "0");
 return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}${separator}${pad(milliseconds % 1000, 3)}`;
}

// Chỉ lấy đoạn đang bật và có chữ, sắp theo thời gian: trình phát phụ đề đòi các mốc tăng dần,
// trong khi thứ tự trong studio là thứ tự người dùng thêm đoạn.
export function subtitleCues(segments = []) {
 return segments
  .filter(segment => segment.enabled !== false && String(segment.subtitleText || "").trim())
  .map(segment => ({
   start: Math.max(0, Number(segment.start) || 0),
   end: Number(segment.end) || 0,
   text: String(segment.subtitleText).trim()
  }))
  .filter(cue => cue.end > cue.start)
  .sort((left, right) => left.start - right.start);
}

export function buildSubtitleFile(segments, format = "srt") {
 if (!SUBTITLE_FORMATS.includes(format)) {
  throw new AppError("UNSUPPORTED_SUBTITLE_FORMAT", "Chỉ hỗ trợ định dạng SRT hoặc VTT.", 422);
 }
 const cues = subtitleCues(segments);
 if (!cues.length) {
  throw new AppError("EMPTY_SUBTITLE_TRACK", "Chưa có đoạn phụ đề nào để xuất.", 422);
 }
 const separator = format === "vtt" ? "." : ",";
 const blocks = cues.map((cue, index) => [
  String(index + 1),
  `${timecode(cue.start, separator)} --> ${timecode(cue.end, separator)}`,
  cue.text
 ].join("\n"));
 return `${format === "vtt" ? "WEBVTT\n\n" : ""}${blocks.join("\n\n")}\n`;
}
