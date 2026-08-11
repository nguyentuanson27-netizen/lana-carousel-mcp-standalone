import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";

const publicUrl = new URL("../public/", import.meta.url);
const [stitchUiJs, socialStudioJs] = await Promise.all([
  fs.readFile(new URL("stitch-ui.js", publicUrl), "utf8"),
  fs.readFile(new URL("social-studio.js", publicUrl), "utf8")
]);

const overview = {
  project: { title: "Regression" },
  accounts: [],
  readiness: {
    carousel: { ready: false, reason: "Chưa sẵn sàng" },
    video: { ready: false, reason: "Chưa render" }
  },
  posts: [],
  feature: {
    encryptionReady: true,
    facebookPageReady: true,
    instagramOAuthReady: true,
    tiktokOAuthReady: true
  }
};

const pageHtml = `<!doctype html>
<html lang="vi">
<body>
  <div id="app" class="studio-app">
    <header class="studio-topbar">
      <span id="meta">Regression · Carousel</span>
      <span id="saveState"><i></i> Không có thay đổi</span>
      <button id="nextWorkflowAction" type="button"></button>
      <button id="mobileSidebarToggle" type="button"></button>
    </header>
    <div class="studio-body">
      <aside id="studioSidebar" class="studio-sidebar">
        <div class="sidebar-brand">
          <span class="brand-mark">L</span>
          <div><strong>Carousel Studio</strong><span id="sidebarProjectName">Regression</span></div>
          <button id="sidebarClose" type="button">×</button>
        </div>
        <section id="slideNavigation" class="slide-navigation">
          <div class="slide-nav-head"><strong id="slideProgress"></strong><button id="slideNavCollapse" type="button">−</button></div>
          <input id="slideSearch">
          <div id="slideFilters"><button class="active" type="button" data-filter="all">Tất cả</button></div>
          <div id="slideRail"></div>
        </section>
      </aside>
      <main class="studio-main">
        <header class="workspace-header">
          <nav id="workflow" class="workflow-nav workspace-workflow">
            <button class="step active" data-view="content" type="button"><span>1</span><b>Duyệt nội dung</b></button>
            <button class="step social-step" data-view="social" type="button"><span>6</span><b>Đăng mạng xã hội</b></button>
          </nav>
          <div class="workspace-heading">
            <span id="workspaceEyebrow">Bước 1 · Carousel</span>
            <h1 id="workspaceTitle">Duyệt nội dung</h1>
            <p id="workspaceDescription">Kiểm tra nội dung.</p>
          </div>
          <div id="workspaceStats"></div>
        </header>
        <div class="workspace-shell">
          <section id="content" class="panel workspace-panel active"></section>
          <section id="social" class="panel workspace-panel social-workspace"></section>
        </div>
      </main>
      <aside class="context-inspector"><div id="inspectorContent"></div></aside>
    </div>
    <div id="mobileBackdrop" hidden></div>
  </div>
  <script src="/stitch-ui.js"></script>
  <script src="/social-studio.js"></script>
</body>
</html>`;

async function withPage(search, run) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("http://lana.local/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ status: 200, contentType: "text/html", body: pageHtml });
    if (path === "/stitch-ui.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: stitchUiJs });
    if (path === "/social-studio.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: socialStudioJs });
    if (path.endsWith("/social/overview")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(overview) });
    }
    return route.fulfill({ status: 404, body: "not found" });
  });
  try {
    await page.goto(`http://lana.local/${search}`);
    await run(page);
  } finally {
    await browser.close();
  }
}

async function assertSocialHeading(page) {
  await page.locator("#social .social-shell").waitFor();
  await page.waitForTimeout(120);
  assert.equal(await page.locator("#workspaceEyebrow").textContent(), "Bước 6 · Publish");
  assert.equal(await page.locator("#workspaceTitle").textContent(), "Đăng mạng xã hội");
  assert.equal(await page.locator("#workflow .social-step").getAttribute("aria-current"), "step");
  assert.equal(await page.locator("#nextWorkflowAction").textContent(), "Làm mới trạng thái");
}

test("direct Social Publisher entry keeps the always-visible workspace heading in sync", async () => {
  await withPage("?projectId=project-1&social=1", async page => {
    await assertSocialHeading(page);
  });
});

test("entering Social Publisher from a Carousel step replaces the previous workspace heading", async () => {
  await withPage("?projectId=project-1", async page => {
    await page.waitForTimeout(120);
    assert.equal(await page.locator("#workspaceTitle").textContent(), "Duyệt nội dung");

    await page.locator("#workflow .social-step").click();
    await assertSocialHeading(page);

    await page.locator('#workflow .step[data-view="content"]').click();
    await page.waitForTimeout(50);
    assert.equal(await page.locator("#workspaceEyebrow").textContent(), "Bước 1 · Carousel");
    assert.equal(await page.locator("#workspaceTitle").textContent(), "Duyệt nội dung");
  });
});
