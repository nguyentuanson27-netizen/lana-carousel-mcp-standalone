import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => fs.readFile(new URL(path, root), "utf8");

test("expired MCP consent fails closed instead of rebuilding an incomplete authorize request", async () => {
  const routes = await read("src/oauth-routes.js");
  assert.match(routes, /function expiredConsentHtml\(\)/u);
  assert.match(routes, /return res\.status\(401\)\.send\(expiredConsentHtml\(\)\)/u);
  assert.equal(/app\.post\("\/oauth\/authorize"[\s\S]*?auth\/google\/start\?returnTo/u.test(routes), false);
});

test("OAuth server does not expose a public client metadata lookup endpoint", async () => {
  const routes = await read("src/oauth-routes.js");
  assert.equal(/\/oauth\/client\/:clientId/u.test(routes), false);
});
