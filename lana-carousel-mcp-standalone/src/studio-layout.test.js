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
