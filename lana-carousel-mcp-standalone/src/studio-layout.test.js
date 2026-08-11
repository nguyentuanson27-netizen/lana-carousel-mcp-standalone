import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const publicUrl = new URL("../public/", import.meta.url);

async function read(name) {
  return fs.readFile(new URL(name, publicUrl), "utf8");
}

test("Content Studio loads wide-layout assets after the existing Stitch assets", async () => {
  const html = await read("widget.html");
  const baseCss = html.indexOf("/stitch-ui.css");
  const layoutCss = html.indexOf("/stitch-layout.css");
  const baseJs = html.indexOf("/stitch-ui.js");
  const layoutJs = html.indexOf("/studio-layout.js");
  assert.ok(baseCss >= 0 && layoutCss > baseCss);
  assert.ok(baseJs >= 0 && layoutJs > baseJs);
});

test("wide layout removes inspector, supports sidebar collapse, and keeps edit toolbar beside preview", async () => {
  const css = await read("stitch-layout.css");
  assert.match(css, /\.context-inspector\s*\{[^}]*display:none!important/su);
  assert.match(css, /\.studio-app\.sidebar-collapsed \.studio-body/su);
  assert.match(css, /#edit \.preview-column\s*\{[^}]*grid-template-columns:116px minmax\(0,1fr\)/su);
  assert.match(css, /#edit \.direct-toolbar\s*\{[^}]*grid-column:1/su);
  assert.match(css, /#edit \.preview-column \.canvas\s*\{[^}]*grid-column:2/su);
  assert.match(css, /#video \.video-stage\s*\{[^}]*100dvh/su);
});

test("edit workspace falls back to one column before expanded sidebar can overflow", async () => {
  const css = await read("stitch-layout.css");
  assert.match(css, /@media\(max-width:1360px\) and \(min-width:1201px\)/u);
  assert.match(css, /@media\(max-width:1200px\)\{\s*#edit \.visual\{\s*grid-template-columns:1fr;/su);
});

test("desktop sidebar collapse is persisted and active view controls compact header visibility", async () => {
  const source = await read("studio-layout.js");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /lana-content-studio-sidebar-collapsed/u);
  assert.match(source, /sidebar-collapsed/u);
  assert.match(source, /studio-view-\$\{view\}/u);
  assert.match(source, /MutationObserver/u);
});

test("edit proof action is promoted into the vertical preview toolbar", async () => {
  const [source, css] = await Promise.all([read("studio-layout.js"), read("stitch-layout.css")]);
  assert.match(source, /\.show-proof/u);
  assert.match(source, /\.direct-toolbar/u);
  assert.match(source, /direct-proof/u);
  assert.match(css, /#edit \.direct-proof/u);
  assert.match(css, /#edit \.proof-bar/u);
});

test("Brand Kit can collapse to an accessible compact summary", async () => {
  const [source, css] = await Promise.all([read("studio-layout.js"), read("stitch-layout.css")]);
  assert.match(source, /lana-content-studio-brand-kit-collapsed/u);
  assert.match(source, /brand-kit-toggle/u);
  assert.match(source, /aria-expanded/u);
  assert.match(source, /brand-kit-summary/u);
  assert.match(css, /\.brand-kit\.is-collapsed/u);
  assert.match(css, /\.brand-kit-toggle/u);
});

test("Carousel workflow moves out of the sidebar into a top horizontal navigation on every view", async () => {
  const [html, css] = await Promise.all([read("widget.html"), read("stitch-layout.css")]);
  const sidebarStart = html.indexOf('<aside id="studioSidebar"');
  const sidebarEnd = html.indexOf("</aside>", sidebarStart);
  const mainStart = html.indexOf('<main class="studio-main">');
  const workflow = html.indexOf('<nav id="workflow"');

  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  assert.ok(mainStart >= 0 && workflow > mainStart, "workflow phải nằm trong vùng workspace phía trên");
  assert.equal(html.slice(sidebarStart, sidebarEnd).includes('id="workflow"'), false, "sidebar không còn phần Quy trình");
  assert.doesNotMatch(html, /workflow-caption/u);
  assert.match(html, /class="workflow-nav workspace-workflow"/u);
  assert.match(css, /\.workspace-workflow\s*\{[^}]*display:flex/su);
  assert.doesNotMatch(css, /\.studio-app:not\(\.studio-view-edit\) \.workspace-header\s*\{[^}]*display:none/su);
});

test("edit preview is sticky, reduced to viewport-safe height, and wheel navigation loops edit slides", async () => {
  const [css, source] = await Promise.all([read("stitch-layout.css"), read("stitch-ui.js")]);
  assert.match(css, /#edit\s*\{[^}]*--edit-preview-height:/su);
  assert.match(css, /#edit \.preview-column\s*\{[^}]*position:sticky/su);
  assert.match(css, /#edit \.preview-column \.canvas\s*\{[^}]*max-height:var\(--edit-preview-height\)/su);
  assert.match(css, /#edit \.preview-column \.canvas\s*\{[^}]*460px/su);
  assert.match(source, /\['images','edit'\]\.includes\(view\)/u);
  assert.match(source, /view === 'edit'[\s\S]*stepSlide\('edit', direction\)/u);
});
