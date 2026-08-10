import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }

const publicUrl = new URL("../public/", import.meta.url);
const [source, css] = await Promise.all([
  fs.readFile(new URL("studio-layout.js", publicUrl), "utf8"),
  fs.readFile(new URL("stitch-layout.css", publicUrl), "utf8")
]);

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/stitch-layout.css"></head><body>
<div id="app" class="studio-app">
  <aside id="studioSidebar"><div class="sidebar-brand"><div>Carousel</div></div></aside>
  <div id="workflow"><button class="step active" data-view="edit">Edit</button></div>
  <header class="workspace-header">
    <div><span>Bước 3 · Carousel</span><h1>Sửa thiết kế</h1></div>
    <div class="brand-kit">
      <label class="field">Font<select id="brandFont"><option>TikTok Sans</option><option>Poppins</option></select></label>
      <label class="field">Màu<input id="brandColor" type="color" value="#ffffff"></label>
      <button id="saveBrand" type="button">Lưu và áp dụng tất cả</button>
    </div>
    <div id="workspaceStats"></div>
  </header>
  <section id="edit">
    <article data-editor="slide-1">
      <div class="preview-column">
        <div class="canvas"></div>
        <div class="direct-toolbar"><span class="direct-hint">Công cụ</span></div>
        <div class="proof-bar"><button type="button" class="tool show-proof">Xem ảnh thật</button><small class="proof-status"></small></div>
      </div>
    </article>
  </section>
</div>
<script src="/studio-layout.js"></script>
</body></html>`;

test("edit layout moves proof action and collapses Brand Kit at runtime", { skip: chromium ? false : "chưa cài playwright" }, async t => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (error) { t.skip(`không mở được Chromium: ${error.message.split("\n")[0]}`); return; }
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("http://studio.test/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/studio-layout.js") return route.fulfill({ contentType: "text/javascript", body: source });
    if (pathname === "/stitch-layout.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ contentType: "text/html", body: pageHtml });
  });
  await page.goto("http://studio.test/");
  await page.waitForSelector(".direct-proof .show-proof");

  assert.equal(await page.locator(".proof-bar").count(), 0);
  assert.equal(await page.locator(".show-proof").evaluate(node => node.closest(".direct-toolbar")?.classList.contains("direct-toolbar")), true);

  const brandToggle = page.locator(".brand-kit-toggle");
  assert.equal(await brandToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".brand-kit > .field").first().evaluate(node => getComputedStyle(node).display), "none");
  assert.equal((await page.locator(".brand-kit-summary-text").textContent())?.trim(), "TikTok Sans");

  await brandToggle.click();
  assert.equal(await brandToggle.getAttribute("aria-expanded"), "true");
  assert.notEqual(await page.locator(".brand-kit > .field").first().evaluate(node => getComputedStyle(node).display), "none");

  await page.selectOption("#brandFont", "Poppins");
  assert.equal((await page.locator(".brand-kit-summary-text").textContent())?.trim(), "Poppins");
});
