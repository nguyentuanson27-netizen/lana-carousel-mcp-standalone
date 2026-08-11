import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const publicUrl = new URL("../public/", import.meta.url);
const [baseCss, layoutCss, layoutJs] = await Promise.all([
  fs.readFile(new URL("stitch-ui.css", publicUrl), "utf8"),
  fs.readFile(new URL("stitch-layout.css", publicUrl), "utf8"),
  fs.readFile(new URL("studio-layout.js", publicUrl), "utf8")
]);

const pageHtml = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/stitch-ui.css">
  <link rel="stylesheet" href="/stitch-layout.css">
</head>
<body>
  <div id="app" class="studio-app studio-view-edit">
    <header class="studio-topbar"><strong>Lana Content Studio</strong></header>
    <div class="studio-body">
      <aside id="studioSidebar" class="studio-sidebar">
        <div class="sidebar-brand">
          <span class="brand-mark">L</span>
          <div><strong>Carousel Studio</strong><span>Regression</span></div>
          <button id="sidebarClose" type="button">×</button>
        </div>
        <section id="slideNavigation" class="slide-navigation">
          <div id="slideRail" class="slide-rail">
            <button class="slide-rail-button active" type="button" data-slide-target="one">Slide 1</button>
            <button class="slide-rail-button" type="button" data-slide-target="two">Slide 2</button>
          </div>
        </section>
      </aside>
      <main class="studio-main">
        <header class="workspace-header compact-workspace-header">
          <nav id="workflow" class="workflow-nav workspace-workflow" aria-label="Quy trình Carousel">
            <button class="step active" data-view="edit" type="button"><span>3</span><b>Sửa thiết kế</b><small>Chữ, crop và Brand Kit</small></button>
          </nav>
          <div class="workspace-heading"><span class="workspace-eyebrow">Bước 3 · Carousel</span><h1>Sửa thiết kế</h1></div>
          <div id="workspaceStats"></div>
        </header>
        <div class="workspace-shell">
          <section id="edit" class="workspace-panel active">
            <article class="card is-active" data-editor="one">
              <div class="visual">
                <div class="preview-column">
                  <div class="direct-toolbar"><span class="direct-hint">Cuộn để chuyển slide</span></div>
                  <div class="canvas" aria-label="Preview slide"></div>
                </div>
                <div class="fields"><label class="field">Nội dung<input value="Slide"></label></div>
              </div>
            </article>
          </section>
        </div>
      </main>
    </div>
  </div>
  <script>
    document.getElementById('slideRail').addEventListener('click', event => {
      const button = event.target.closest('[data-slide-target]');
      if (!button) return;
      document.querySelectorAll('#slideRail [data-slide-target]').forEach(item => item.classList.toggle('active', item === button));
    });
  </script>
  <script src="/studio-layout.js"></script>
</body>
</html>`;

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("http://lana.local/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml });
    if (path === "/stitch-ui.css") return route.fulfill({ status: 200, contentType: "text/css", body: baseCss });
    if (path === "/stitch-layout.css") return route.fulfill({ status: 200, contentType: "text/css", body: layoutCss });
    if (path === "/studio-layout.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: layoutJs });
    return route.fulfill({ status: 404, body: "not found" });
  });
  try {
    await page.goto("http://lana.local/");
    await run(page);
  } finally {
    await browser.close();
  }
}

test("Carousel top workflow and edit preview stay viewport-safe while wheel navigation loops", async () => {
  await withPage(async page => {
    assert.equal(await page.locator("#workflow").evaluate(element => getComputedStyle(element).display), "flex");

    const preview = await page.locator("#edit .canvas").boundingBox();
    assert.ok(preview, "preview phải hiển thị");
    assert.ok(preview.height <= 650, `preview cao ${preview.height}px, phải nằm trong giới hạn viewport`);
    assert.ok(preview.y + preview.height <= 900, "preview phải nằm trọn trong viewport 900px");

    const column = await page.locator("#edit .preview-column").boundingBox();
    assert.ok(column);
    await page.mouse.move(column.x + column.width / 2, column.y + 40);

    await page.mouse.wheel(0, -120);
    assert.equal(await page.locator("#slideRail .active").getAttribute("data-slide-target"), "two", "cuộn lên từ slide đầu phải loop về slide cuối");

    await page.waitForTimeout(350);
    await page.mouse.wheel(0, 120);
    assert.equal(await page.locator("#slideRail .active").getAttribute("data-slide-target"), "one", "cuộn xuống từ slide cuối phải loop về slide đầu");

    await page.waitForTimeout(350);
    await page.locator("#edit .preview-column").dispatchEvent("wheel", { deltaY: 120, ctrlKey: true });
    assert.equal(await page.locator("#slideRail .active").getAttribute("data-slide-target"), "one", "Ctrl+wheel phải được giữ cho zoom, không đổi slide");
  });
});
