import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { GOOGLE_VOICES, VERTEX_VOICES, LUCYLAB_VOICE_IDS } from "./video-tts.js";

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
      // 4s ở tốc độ đọc 1: ngân sách 13 từ. Đoạn s2 14 từ nên vượt budget.
      { id: "s1", start: 0, end: 4, subtitleText: "xin chao", voiceOverText: "một hai ba bốn" },
      { id: "s2", start: 4, end: 8, subtitleText: "tam biet", voiceOverText: "một hai ba bốn năm sáu bảy tám chín mười mười_một mười_hai mười_ba mười_bốn" }
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

async function withPage(run, served = project, hooks = {}) {
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
    if (url.pathname.endsWith("/voice-sample")) {
      if (hooks.voiceSample) return hooks.voiceSample(route);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "http://lana.local/sample.mp3", voice: "Kore" })
      });
    }
    if (url.pathname.endsWith("/voice-preview")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ voiceTracks: [] })
      });
    }
    if (url.pathname.endsWith("/versions")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
    }
    if (url.pathname.startsWith("/api/video-analysis/projects/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(served) });
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

async function installFakeAudio(page) {
  await page.evaluate(() => {
    window.__fakeAudios = [];
    window.Audio = class FakeAudio {
      constructor(url) {
        this.url = url;
        this.paused = true;
        this.currentTime = 0;
        this.duration = 1;
        this.volume = 1;
        this.playbackRate = 1;
        this.pauseCount = 0;
        window.__fakeAudios.push(this);
      }
      play() {
        this.paused = false;
        return Promise.resolve();
      }
      pause() {
        this.paused = true;
        this.pauseCount += 1;
      }
      removeAttribute() {}
      load() {}
    };
  });
}

const fakeAudioState = page => page.evaluate(() => window.__fakeAudios.map(audio => ({
  url: audio.url,
  paused: audio.paused,
  pauseCount: audio.pauseCount
})));

function pendingVoiceSample() {
  let markStarted;
  let release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return {
    started,
    release,
    async handler(route) {
      markStarted();
      await released;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "http://lana.local/sample.mp3", voice: "Kore" })
      });
    }
  };
}

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

test("starting video playback stops a standalone voice sample", async () => {
  await withPage(async page => {
    await installFakeAudio(page);
    await page.locator("#voiceSample").click();
    await page.waitForFunction(() => window.__fakeAudios.length === 1 && !window.__fakeAudios[0].paused);

    await page.locator("#video").dispatchEvent("play");
    assert.deepEqual(await fakeAudioState(page), [
      { url: "http://lana.local/sample.mp3", paused: true, pauseCount: 1 }
    ]);
  });
});

test("starting voice preview stops a standalone voice sample", async () => {
  await withPage(async page => {
    await installFakeAudio(page);
    await page.locator("#voiceSample").click();
    await page.waitForFunction(() => window.__fakeAudios.length === 1 && !window.__fakeAudios[0].paused);

    await page.locator("#voicePreview").click();
    await page.waitForFunction(() => window.__fakeAudios[0].paused);
    assert.deepEqual(await fakeAudioState(page), [
      { url: "http://lana.local/sample.mp3", paused: true, pauseCount: 1 }
    ]);
  });
});

for (const scenario of [
  { name: "video playback", startPreview: page => page.locator("#video").dispatchEvent("play") },
  { name: "voice preview", startPreview: page => page.locator("#voicePreview").click() }
]) {
  test(`a pending standalone voice sample cannot start after ${scenario.name} begins`, async () => {
    const pending = pendingVoiceSample();
    await withPage(async page => {
      await installFakeAudio(page);
      await page.locator("#voiceSample").click();
      await pending.started;

      await scenario.startPreview(page);
      pending.release();
      await page.waitForFunction(() => !document.querySelector("#voiceSample").disabled);

      assert.deepEqual(await fakeAudioState(page), []);
    }, project, { voiceSample: pending.handler });
  });
}

const voiceFields = page => page.evaluate(() => ({
  vertexShown: !document.querySelector("#voiceField").hidden,
  vertexDisabled: document.querySelector("#voice").disabled,
  googleShown: !document.querySelector("#googleVoiceField").hidden,
  googleDisabled: document.querySelector("#googleVoice").disabled,
  note: document.querySelector("#voiceNote").textContent
}));

const options = (page, id) => page.locator(id).evaluate(select => [...select.options].map(option => option.value));

// Hai nhà cung cấp không đọc được tên giọng của nhau, nên bộ chọn phải đổi theo nhà cung cấp:
// để nguyên bộ chọn Vertex khi đang ở Google là mời người dùng chọn một thứ không hề được dùng.
test("swaps the voice picker to the provider that will actually read", async () => {
  await withPage(async page => {
    assert.deepEqual(await voiceFields(page), {
      vertexShown: true,
      vertexDisabled: false,
      googleShown: false,
      googleDisabled: true,
      note: "Vertex Gemini đọc bằng Kore."
    });

    await page.locator("#ttsProvider").selectOption("google");
    assert.deepEqual(await voiceFields(page), {
      vertexShown: false,
      vertexDisabled: true,
      googleShown: true,
      googleDisabled: false,
      note: "Google TTS đọc bằng vi-VN-Neural2-D. Giọng Vertex (Kore, Puck…) không dùng được ở đây."
    });

    await page.locator("#googleVoice").selectOption("vi-VN-Wavenet-C");
    assert.match((await voiceFields(page)).note, /vi-VN-Wavenet-C/u);
  });
});

// Bộ chọn phải liệt kê đúng những giọng route chấp nhận, nếu không studio sẽ mời chọn một giọng
// mà chính server từ chối nghe thử.
test("offers exactly the voices the server accepts for each provider", async () => {
  await withPage(async page => {
    assert.deepEqual(await options(page, "#voice"), VERTEX_VOICES);
    assert.deepEqual(await options(page, "#googleVoice"), GOOGLE_VOICES);
    assert.deepEqual(await options(page, "#lucylabVoice"), LUCYLAB_VOICE_IDS);
  });
});

test("keeps a saved Google voice that the picker does not list", async () => {
  const saved = { ...project, settings: { ...project.settings, ttsProvider: "google", ttsVoice: "vi-VN-Chirp3-HD-Aoede" } };
  await withPage(async page => {
    assert.equal(await page.locator("#googleVoice").inputValue(), "vi-VN-Chirp3-HD-Aoede");
    assert.match((await voiceFields(page)).note, /vi-VN-Chirp3-HD-Aoede/u);
  }, saved);
});

test("does not leak a legacy Lucylab voice into the Google picker", async () => {
  const lucylabVoice = LUCYLAB_VOICE_IDS[1];
  const saved = {
    ...project,
    settings: { ...project.settings, ttsProvider: "lucylab", ttsVoice: lucylabVoice, lucylabVoice }
  };
  await withPage(async page => {
    assert.equal(await page.locator("#lucylabVoice").inputValue(), lucylabVoice);
    assert.ok(!(await options(page, "#googleVoice")).includes(lucylabVoice));
    await page.locator("#ttsProvider").selectOption("google");
    assert.equal(await page.locator("#googleVoice").inputValue(), "vi-VN-Neural2-D");
  }, saved);
});

test("saves Google and Lucylab voice choices independently", async () => {
  await withPage(async page => {
    await page.locator("#ttsProvider").selectOption("google");
    await page.locator("#googleVoice").selectOption("vi-VN-Wavenet-C");
    await page.locator("#ttsProvider").selectOption("lucylab");
    await page.locator("#lucylabVoice").selectOption(LUCYLAB_VOICE_IDS[1]);

    const requestPromise = page.waitForRequest(request => request.url().endsWith("/script") && request.method() === "PUT");
    await page.locator("#save").click();
    const request = await requestPromise;
    const body = request.postDataJSON();
    assert.equal(body.settings.ttsVoice, "vi-VN-Wavenet-C");
    assert.equal(body.settings.lucylabVoice, LUCYLAB_VOICE_IDS[1]);
  });
});

const budgets = page => page.locator(".segment .budget").evaluateAll(nodes => nodes.map(node => ({
  text: node.textContent,
  status: node.className.replace("budget", "").trim()
})));

test("shows how much of each segment's reading time the voice-over uses", async () => {
  await withPage(async page => {
    assert.deepEqual(await budgets(page), [
      { text: "4/13 từ · vừa", status: "good" },
      { text: "14/13 từ · quá dài, sẽ bị đọc ép nhanh", status: "over" }
    ]);
  });
});

test("marks a valid segment with zero whole-word capacity as over budget", async () => {
  await withPage(async page => {
    await page.locator(".segment .end").first().fill("0.3");
    await page.locator(".segment .end").first().dispatchEvent("input");
    assert.deepEqual((await budgets(page))[0], {
      text: "4/0 từ · quá dài, sẽ bị đọc ép nhanh",
      status: "over"
    });
  });
});

test("recalculates the budget as the segment or the reading speed changes", async () => {
  await withPage(async page => {
    // Đổi đoạn đầu thành 1.4s: 1.4 * 3.3 = 4.62 -> ngân sách 4 từ, câu 4 từ sát giới hạn (tight).
    await page.locator(".segment .end").first().fill("1.4");
    await page.locator(".segment .end").first().dispatchEvent("input");
    assert.deepEqual((await budgets(page))[0], { text: "4/4 từ · sát giới hạn", status: "tight" });

    // Đọc nhanh x2 thì 1.4s chứa được 1.4 * 3.3 * 2 = 9.24 -> 9 từ.
    await page.locator("#ttsSpeed").selectOption("2");
    assert.deepEqual((await budgets(page))[0], { text: "4/9 từ · vừa", status: "good" });
  });
});

test("swaps to Lucylab AI and keeps the Lucylab voice note in sync", async () => {
  await withPage(async page => {
    await page.locator("#ttsProvider").selectOption("lucylab");
    const state = await page.evaluate(() => ({
      vertexShown: !document.querySelector("#voiceField").hidden,
      googleShown: !document.querySelector("#googleVoiceField").hidden,
      lucylabShown: !document.querySelector("#lucylabVoiceField").hidden,
      lucylabDisabled: document.querySelector("#lucylabVoice").disabled,
      note: document.querySelector("#voiceNote").textContent
    }));
    assert.deepEqual(state, {
      vertexShown: false,
      googleShown: false,
      lucylabShown: true,
      lucylabDisabled: false,
      note: "Lucylab AI đọc bằng My Review (Nữ miền Nam)."
    });

    await page.locator("#lucylabVoice").selectOption(LUCYLAB_VOICE_IDS[1]);
    assert.match(await page.locator("#voiceNote").textContent(), /Thư Review/u);
  });
});

test("updates the live subtitle preview when the preset changes", async () => {
  await withPage(async page => {
    const previewState = () => page.locator("#caption").evaluate(element => ({
      text: element.textContent,
      wordMode: element.classList.contains("word-mode"),
      background: element.style.background,
      border: element.style.border,
      textShadow: element.style.textShadow,
      webkitTextStroke: element.style.webkitTextStroke,
      activeColor: element.querySelector(".active-word")?.style.color || "",
      activeTransform: element.querySelector(".active-word")?.style.transform || ""
    }));

    await page.locator("#subtitlePreset").selectOption("tiktok-classic");
    let state = await previewState();
    assert.equal(state.text, "xin chao");
    assert.equal(state.wordMode, false);
    assert.equal(state.background, "rgba(0, 0, 0, 0.72)");
    assert.equal(state.border, "");
    assert.match(state.textShadow, /rgba\(0, 0, 0, 0\.6\)/u);
    assert.ok(parseFloat(state.textShadow.match(/[\d.]+px/iu)?.[0] || "0") > 0);
    assert.equal(state.webkitTextStroke, "");
    assert.equal(state.activeColor, "rgb(255, 230, 0)");
    assert.equal(state.activeTransform, "");

    await page.locator("#subtitlePreset").selectOption("capcut-stroke");
    state = await previewState();
    assert.equal(state.text, "xin chao");
    assert.equal(state.wordMode, false);
    assert.equal(state.background, "transparent");
    assert.equal(state.border, "");
    assert.match(state.textShadow, /rgba\(0, 0, 0, 0\.95\)/u);
    assert.ok(parseFloat(state.textShadow.match(/[\d.]+px/iu)?.[0] || "0") > 0);
    assert.match(state.webkitTextStroke, /rgb\(0, 0, 0\)/u);
    assert.ok(parseFloat(state.webkitTextStroke) > 0);
    assert.equal(state.activeColor, "rgb(0, 242, 254)");
    assert.equal(state.activeTransform, "");

    await page.locator("#subtitlePreset").selectOption("neon-glow");
    state = await previewState();
    assert.equal(state.text, "xin chao");
    assert.equal(state.wordMode, false);
    assert.equal(state.background, "rgba(10, 10, 15, 0.65)");
    assert.equal(state.border, "");
    assert.match(state.textShadow, /rgb\(255, 0, 127\)/u);
    assert.ok(state.textShadow.includes(","), "neon phải có hai lớp glow");
    assert.equal(state.webkitTextStroke, "");
    assert.equal(state.activeColor, "rgb(255, 252, 0)");
    assert.equal(state.activeTransform, "");

    await page.locator("#subtitlePreset").selectOption("box-gradient");
    state = await previewState();
    assert.match(state.background, /linear-gradient/u);
    assert.match(state.border, /solid rgba\(255, 255, 255, 0\.25\)/u);
    assert.ok(parseFloat(state.border) > 0);

    await page.locator("#subtitlePreset").selectOption("bounce-pop");
    state = await previewState();
    assert.equal(state.text, "xin");
    assert.equal(state.wordMode, true);
    assert.equal(state.activeColor, "rgb(255, 230, 0)");
    assert.equal(state.activeTransform, "scale(1.12)");

    // Đổi preset chỉ đổi cách trình bày preview; không được âm thầm sửa các control người dùng.
    await page.locator("#subtitleColor").evaluate(element => {
      element.value = "#123456";
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.locator("#subtitleOpacity").fill("0.35");
    await page.locator("#subtitlePreset").selectOption("capcut-stroke");
    assert.equal(await page.locator("#subtitleColor").inputValue(), "#123456");
    assert.equal(await page.locator("#subtitleOpacity").inputValue(), "0.35");

    // Keyword colors trong preview phải theo đúng renderer.
    await page.locator("#subtitlePreset").selectOption("tiktok-classic");
    await page.locator(".segment .sub").first().fill("sale xin");
    await page.locator(".segment .sub").first().dispatchEvent("input");
    assert.equal(
      await page.locator("#caption .active-word").evaluate(element => element.style.color),
      "rgb(255, 77, 79)"
    );

    await page.locator(".segment .sub").first().fill("xin sale");
    await page.locator(".segment .sub").first().dispatchEvent("input");
    const colors = await page.locator("#caption span").evaluateAll(nodes => nodes.map(node => node.style.color));
    assert.equal(colors.at(-1), "rgb(255, 223, 112)");
  });
});
