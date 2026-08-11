import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const enabled = process.env.RUN_REMOTION_INTEGRATION === "1";

test("renders a real landscape Remotion MP4 with animated rich text near the edge", { skip: !enabled }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-remotion-"));
  const output = path.join(directory, "render.mp4");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#efe5dc"/><rect x="60" y="60" width="1800" height="960" rx="72" fill="#8d3f3d"/></svg>`;
  const inputProps = {
    scenes: [{
      id: "scene-1", enabled: true, duration: 1, motion: "none", transition: "cut",
      subtitles: false,
      textLayers: [{
        id: "edge", content: "Lana edge", enabled: true, animation: "by-word", animationDelay: 0,
        x: 93, y: 8, align: "right", font: "Arial", size: 72, color: "#FFFFFF", weight: "700",
        styleRanges: [{ start: 0, end: 4, color: "#FFDF70", weight: "900" }]
      }],
      imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      focusX: 50, focusY: 50, kenBurnsIntensity: .14
    }],
    aspectRatio: "landscape", fps: 24, audioUrl: "", voiceUrl: ""
  };
  const entryPoint = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../video/index.jsx");
  const serveUrl = await bundle({ entryPoint });
  const composition = await selectComposition({ serveUrl, id: "LanaCarouselVideo", inputProps });
  assert.deepEqual([composition.width, composition.height], [1920, 1080]);
  await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: output, inputProps, concurrency: 1, crf: 30 });
  const stat = await fs.stat(output);
  assert.ok(stat.size > 1_000, `Expected a non-empty MP4, received ${stat.size} bytes`);
});

function toneWav({seconds=1,sampleRate=24000,frequency=440,amplitude=12000}={}){
  const samples = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function lastAudibleSecond(wav) {
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    }
    if (chunkId === "data") {
      const stride = (bits / 8) * channels;
      const frames = Math.min(chunkSize, wav.length - offset - 8) / stride;
      let last = -1;
      for (let frame = 0; frame < frames; frame += 1) {
        if (Math.abs(wav.readInt16LE(offset + 8 + frame * stride)) > 500) last = frame;
      }
      return last < 0 ? -1 : last / sampleRate;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return -1;
}

async function withMediaServer(files, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-voice-"));
  for (const [name, buffer] of Object.entries(files)) await fs.writeFile(path.join(directory, name), buffer);
  const server = http.createServer((request, response) => {
    const file = path.join(directory, path.basename(decodeURIComponent(request.url.split("?")[0])));
    createReadStream(file)
      .on("error", () => response.writeHead(404).end("not found"))
      .on("open", () => response.writeHead(200, { "content-type": file.endsWith(".mp4") ? "video/mp4" : "audio/wav" }))
      .pipe(response);
  });
  await new Promise(resolve => server.listen(0, resolve));
  try {
    await run({ directory, origin: `http://localhost:${server.address().port}` });
  } finally {
    server.close();
  }
}

// Nhánh TTS trả MP3 chỉ kèm độ dài ước lượng theo số từ. Nếu độ dài đó được dùng làm
// điểm cắt của <Sequence> thì clip nào đọc dài hơn ước lượng sẽ mất phần cuối câu.
test("a voice clip with an estimated duration plays to its real end instead of being cut", { skip: !enabled }, async () => {
  const entryPoint = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../video/index.jsx");
  const serveUrl = await bundle({ entryPoint });
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#222"/></svg>`;
  const sourceProps = {
    scenes: [{
      id: "backdrop", enabled: true, duration: 3, motion: "none", transition: "cut", subtitles: false,
      textLayers: [], imageUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      focusX: 50, focusY: 50
    }],
    aspectRatio: "vertical", fps: 30, audioUrl: "", voiceUrl: ""
  };
  const sourceComposition = await selectComposition({ serveUrl, id: "LanaCarouselVideo", inputProps: sourceProps, browserExecutable });

  await withMediaServer({ "voice.wav": toneWav({ seconds: 1 }) }, async ({ directory, origin }) => {
    const sourceVideo = path.join(directory, "source.mp4");
    await renderMedia({
      composition: sourceComposition, serveUrl, codec: "h264", outputLocation: sourceVideo,
      inputProps: sourceProps, concurrency: 1, crf: 30, browserExecutable
    });

    // Clip thật dài 1s nhưng chỉ khai báo 0.3s, đúng kiểu độ dài ước lượng của nhánh Google.
    const renderVoice = async measured => {
      const props = {
        sourceVideoUrl: `${origin}/source.mp4`,
        sourceDuration: 3,
        segments: [{ id: "s1", start: 0, end: 3, subtitleText: "x", voiceOverText: "x", enabled: true }],
        settings: { originalAudioVolume: 0, ttsVolume: 1, subtitleEnabled: false },
        voiceTracks: [{ id: "s1", url: `${origin}/voice.wav`, start: 0, duration: .3, playbackRate: 1, measured }],
        voiceDuration: 3
      };
      const composition = await selectComposition({ serveUrl, id: "LanaAnalyzedVideo", inputProps: props, browserExecutable });
      const output = path.join(directory, `voice-${measured}.wav`);
      await renderMedia({
        composition, serveUrl, codec: "wav", outputLocation: output, inputProps: props,
        concurrency: 1, browserExecutable, chromiumOptions: { disableWebSecurity: true }
      });
      return lastAudibleSecond(await fs.readFile(output));
    };

    const estimated = await renderVoice(false);
    assert.ok(estimated > .9, `Clip ước lượng phải đọc hết 1s, tiếng dừng ở ${estimated}s`);
    const measured = await renderVoice(true);
    assert.ok(measured < .35, `Clip đã đo được phép cắt đúng 0.3s, tiếng dừng ở ${measured}s`);
  });
});
