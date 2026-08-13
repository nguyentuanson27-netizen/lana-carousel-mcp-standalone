import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

// Dùng thẳng trang thật thay vì dựng lại một bản rút gọn: studio gắn handler cho nhiều nút ngay
// lúc nạp, nên một trang giả thiếu phần tử sẽ làm cả script chết mà test lại không thấy.
const publicUrl = new URL("../public/", import.meta.url);
const [pageHtml, studioJs, wordBudgetJs] = await Promise.all([
  fs.readFile(new URL("video-studio.html", publicUrl), "utf8"),
  fs.readFile(new URL("video-studio.js", publicUrl), "utf8"),
  fs.readFile(new URL("video-word-budget.js", publicUrl), "utf8")
]);

const project = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Preview volume",
  status: "APPROVED",
  source: { url: "http://lana.local/source.mp4", filename: "source.mp4", duration: 8 },
  script: {
    summary: "",
    segments: [
      // 4s ở tốc độ đọc 1 cho ngân sách 8 từ: đoạn đầu vừa, đoạn sau vượt.
      { id: "s1", start: 0, end: 4, subtitleText: "xin chao", voiceOverText: "một hai ba bốn" },
      { id: "s2", start: 4, end: 8, subtitleText: "tam biet", voiceOverText: "một hai ba bốn năm sáu bảy tám chín mười" }
    ]
  },
  settings: {
    originalAudioVolume: 0,
    ttsVolume: 0.75,
    ttsSpeed: 1,
    subtitleEnabled: true,
    subtitleStyle: "karaoke"
  },
  currentVersion: 1
};

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("http://lana.local/**", async route => {
    const url = new URL(route.request().url());
    const body = {
      "/video-studio": { type: "text/html", body: pageHtml },
      "/video-studio.js": { type: "text/javascript", body: studioJs },
      "/video-word-budget.js": { type: "text/javascript", body: wordBudgetJs },
      "/fonts.css": { type: "text/css", body: "" }
    }[url.pathname];
    if (body) return route.fulfill({ status: 200, contentType: body.type, body: body.body });
    if (url.pathname.endsWith("/versions")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
    }
    if (url.pathname.startsWith("/api/video-analysis/projects/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project) });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  const failures = [];
  page.on("pageerror", error => failures.push(String(error)));
  try {
    await page.goto(`http://lana.local/video-studio?projectId=${project.id}`);
    await page.waitForFunction(() => document.querySelectorAll(".segment").length > 0);
    await run(page);
    assert.deepEqual(failures, [], "trang không được ném lỗi khi nạp");
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

const budgets = page => page.locator(".segment .budget").evaluateAll(nodes => nodes.map(node => ({
  text: node.textContent,
  status: node.className.replace("budget", "").trim()
})));

test("shows how much of each segment's reading time the voice-over uses", async () => {
  await withPage(async page => {
    assert.deepEqual(await budgets(page), [
      { text: "4/8 từ · vừa", status: "good" },
      { text: "10/8 từ · quá dài, sẽ bị đọc ép nhanh", status: "over" }
    ]);
  });
});

test("recalculates the budget as the segment or the reading speed changes", async () => {
  await withPage(async page => {
    // Rút ngắn đoạn đầu còn 2s: ngân sách tụt xuống 4 từ nên câu 4 từ thành sát giới hạn.
    await page.locator(".segment .end").first().fill("2");
    await page.locator(".segment .end").first().dispatchEvent("input");
    assert.deepEqual((await budgets(page))[0], { text: "4/4 từ · sát giới hạn", status: "tight" });

    // Đọc nhanh hơn thì cùng thời lượng chứa được nhiều chữ hơn.
    await page.locator("#ttsSpeed").selectOption("2");
    assert.deepEqual((await budgets(page))[0], { text: "4/8 từ · vừa", status: "good" });
  });
});
