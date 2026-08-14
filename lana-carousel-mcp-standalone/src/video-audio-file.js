// Đọc header của chính tệp audio để lấy độ dài thật. getVideoMetadata của Remotion treo vô hạn
// trên tệp thuần audio, mà với một render job thì treo còn tệ hơn sai số: nó chặn cả hàng đợi.

const MP3_LAYER_III = 1;
const MP3_VERSION_1 = 3;
const MP3_TRAILING_SLACK = 512;
const MP3_BITRATES = {
 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
};
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function decodeAudioDataUrl(dataUrl) {
 const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/su.exec(String(dataUrl || ""));
 if (!match) throw new Error("TTS trả về dữ liệu âm thanh không hợp lệ.");
 const buffer = Buffer.from(match[2], "base64");
 if (!buffer.length) throw new Error("TTS trả về tệp âm thanh trống.");
 const mime = match[1].toLowerCase();
 const extension = mime.includes("mpeg") || mime.includes("mp3") ? "mp3"
  : mime.includes("ogg") ? "ogg"
  : mime.includes("webm") ? "webm"
  : "wav";
 return { buffer, extension };
}

export function wavDurationSeconds(buffer) {
 if (buffer.length < 44) return 0;
 if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return 0;
 let offset = 12;
 let byteRate = 0;
 while (offset + 8 <= buffer.length) {
  const chunkId = buffer.toString("ascii", offset, offset + 4);
  const chunkSize = buffer.readUInt32LE(offset + 4);
  if (chunkId === "fmt " && offset + 20 <= buffer.length) byteRate = buffer.readUInt32LE(offset + 16);
  if (chunkId === "data") return byteRate > 0 ? Math.min(chunkSize, buffer.length - offset - 8) / byteRate : 0;
  offset += 8 + chunkSize + (chunkSize % 2);
 }
 return 0;
}

// Cộng dồn độ dài từng frame Layer III nên đúng cho cả CBR lẫn VBR.
export function mp3DurationSeconds(buffer) {
 let offset = 0;
 if (buffer.length > 10 && buffer.toString("ascii", 0, 3) === "ID3") {
  const tagSize = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
  offset = 10 + tagSize + ((buffer[5] & 0x10) ? 10 : 0);
 }
 let duration = 0;
 let frames = 0;
 while (offset + 4 <= buffer.length) {
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) break;
  const version = (buffer[offset + 1] >> 3) & 0x03;
  const layer = (buffer[offset + 1] >> 1) & 0x03;
  if (version === 1 || layer !== MP3_LAYER_III) break;
  const bitrate = MP3_BITRATES[version === MP3_VERSION_1 ? 1 : 2][(buffer[offset + 2] >> 4) & 0x0f] * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version][(buffer[offset + 2] >> 2) & 0x03];
  if (!bitrate || !sampleRate) break;
  const frameLength = Math.floor((version === MP3_VERSION_1 ? 144 : 72) * bitrate / sampleRate) + ((buffer[offset + 2] >> 1) & 0x01);
  if (frameLength < 4) break;
  duration += (version === MP3_VERSION_1 ? 1152 : 576) / sampleRate;
  frames += 1;
  offset += frameLength;
 }
 // Chỉ tin kết quả khi đã duyệt gần hết tệp. Dừng giữa chừng nghĩa là gặp dữ liệu không đọc
 // được, và con số thu về sẽ ngắn hơn thật — đúng hướng gây cắt mất tiếng.
 return frames > 0 && buffer.length - offset <= MP3_TRAILING_SLACK ? duration : 0;
}

export function measureAudioDuration(buffer, extension) {
 if (extension === "wav") return wavDurationSeconds(buffer);
 if (extension === "mp3") return mp3DurationSeconds(buffer);
 return 0;
}
