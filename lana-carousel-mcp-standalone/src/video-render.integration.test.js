import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
