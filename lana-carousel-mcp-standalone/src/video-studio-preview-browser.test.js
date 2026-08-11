import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const publicUrl = new URL("../public/", import.meta.url);
const studioJs = await fs.readFile(new URL("video-studio.js", publicUrl), "utf8");

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Preview volume",
  status: "APPROVED",
  source: { url: "http://lana.local/source.mp4", filename: "source.mp4", duration: 4 },
  script: { summary: "", segments: [{ id: "s1", start: 0, end: 3, subtitleText: "xin chao", voiceOverText: "xin chao" }] },
  settings: { originalAudioVolume: 0, ttsVolume: 0.75, subtitleEnabled: true, subtitleStyle: "karaoke" },
  currentVersion: 1
};

const pageHtml = `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><title>Video studio preview</title></head>
<body>
  <div id="stage"><video id="video" controls playsinline></video><div id="caption" hidden></div></div>
  <div id="job"></div>
  <h1 id="title"></h1>
  <a id="download" download><button type="button">tai</button></a>
  <button id="save"></button><button id="approve"></button><button id="render"></button>
  <button id="addSegment"></button><button id="newBtn"></button><button id="attach"></button>
  <input id="upload" type="file"><input id="sourceUrl"><span id="sourceInfo"></span>
  <textarea id="summary"></textarea><div id="segments"></div><div id="versions"></div>
  <details open>
    <input id="ttsEnabled" type="checkbox"><select id="ttsProvider"><option value="vertex">vertex</option></select>
    <select id="voice"><option>Kore</option></select>
    <select id="ttsSpeed"><option value="1">1</option></select><output id="ttsSpeedValue"></output>
    <input id="originalVolume" type="range" min="0" max="1" step=".05"><output id="originalVolumeValue"></output>
    <input id="ttsVolume" type="range" min="0" max="1" step=".05"><output id="ttsVolumeValue"></output>
    <input id="subtitleEnabled" type="checkbox">
    <select id="subtitleStyle"><option value="karaoke">karaoke</option></select>
    <select id="subtitleFont"><option>Roboto</option></select>
    <input id="subtitleSize" type="range" min="20" max="96"><output id="subtitleSizeValue"></output>
    <input id="subtitleColor" type="color"><input id="subtitleBg" type="color">
    <input id="subtitleOpacity" type="range" min="0" max="1" step=".05"><output id="subtitleOpacityValue"></output>
    <input id="subtitleX" type="range" min="6" max="94"><output id="subtitleXValue"></output>
    <input id="subtitlePosition" type="range" min="6" max="94"><output id="subtitlePositionValue"></output>
  </details>
  <script src="/video-studio.js"></script>
</body>
</html>`;

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("http://lana.local/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/video-studio") {
      return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml });
    }
    if (url.pathname === "/video-studio.js") {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: studioJs });
    }
    if (url.pathname.endsWith("/versions")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
    }
    if (url.pathname.startsWith("/api/video-analysis/projects/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project) });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  try {
    await page.goto(`http://lana.local/video-studio?projectId=${project.id}`);
    await page.waitForFunction(() => document.querySelector("#originalVolumeValue").value !== "");
    await run(page);
  } finally {
    await browser.close();
  }
}

const previewAudio = page => page.locator("#video").evaluate(element => ({
  volume: element.volume,
  muted: element.muted
}));

test("a saved zero original volume mutes the studio preview instead of playing the source at full volume", async () => {
  await withPage(async page => {
    assert.equal(await page.locator("#originalVolume").inputValue(), "0");
    assert.deepEqual(await previewAudio(page), { volume: 0, muted: true });
  });
});

test("moving the original volume slider retunes the preview without a reload", async () => {
  await withPage(async page => {
    await page.locator("#originalVolume").fill("0.5");
    await page.locator("#originalVolume").dispatchEvent("input");
    assert.deepEqual(await previewAudio(page), { volume: 0.5, muted: false });

    await page.locator("#originalVolume").fill("0");
    await page.locator("#originalVolume").dispatchEvent("input");
    assert.deepEqual(await previewAudio(page), { volume: 0, muted: true });
  });
});
