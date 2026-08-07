import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { decryptWithKey, encryptWithKey } from "./social-crypto.js";
import { buildTikTokPhotoDraftPayload } from "./social-provider-tiktok.js";

const root = new URL("../", import.meta.url);
const read = path => fs.readFile(new URL(path, root), "utf8");

test("social credentials use authenticated encryption and reject the wrong key", () => {
  const key = "a".repeat(64);
  const otherKey = "b".repeat(64);
  const plain = "token-that-must-never-be-stored-in-plaintext";
  const encrypted = encryptWithKey(plain, key);
  assert.notEqual(encrypted, plain);
  assert.equal(encrypted.includes(plain), false);
  assert.equal(decryptWithKey(encrypted, key), plain);
  assert.throws(() => decryptWithKey(encrypted, otherKey), /giải mã credential/u);
});

test("TikTok photo MVP uses Upload Draft instead of Direct Post", () => {
  const payload = buildTikTokPhotoDraftPayload({
    images: [{ url: "https://content.example/social-media/1.webp" }, { url: "https://content.example/social-media/2.webp" }],
    caption: "Caption thử nghiệm"
  });
  assert.equal(payload.post_mode, "MEDIA_UPLOAD");
  assert.equal(payload.media_type, "PHOTO");
  assert.equal(payload.source_info.source, "PULL_FROM_URL");
  assert.deepEqual(payload.source_info.photo_images, [
    "https://content.example/social-media/1.webp",
    "https://content.example/social-media/2.webp"
  ]);
});

test("Content Studio exposes step 6 without teaching the legacy view controller about social", async () => {
  const [html, legacy, socialUi] = await Promise.all([
    read("public/widget.html"),
    read("public/stitch-ui.js"),
    read("public/social-studio.js")
  ]);
  assert.match(html, /data-view="social"/u);
  assert.match(html, /id="social"/u);
  assert.match(html, /social-studio\.css/u);
  assert.match(html, /social-studio\.js/u);
  assert.equal(/social:\s*\{\s*step:/u.test(legacy), false);
  assert.doesNotThrow(() => new Function(socialUi));
  assert.match(socialUi, /stopImmediatePropagation/u);
  assert.match(socialUi, /data-social-publish/u);
});

test("Social API is admin-only while provider media is HMAC signed", async () => {
  const [routes, media, server] = await Promise.all([
    read("src/social-routes.js"),
    read("src/social-media.js"),
    read("src/http-server.js")
  ]);
  assert.match(routes, /\["admin-session",\s*"api-key"\]\.includes\(req\.apiAccessType\)/u);
  assert.match(routes, /SOCIAL_ADMIN_REQUIRED/u);
  assert.match(media, /verifyMediaSignature/u);
  assert.match(media, /renderSlideSnapshot/u);
  assert.match(server, /import \{ registerSocialRoutes \} from "\.\/social-routes\.js"/u);
  assert.match(server, /registerSocialRoutes\(app\)/u);
});

test("Social persistence separates posts and platform deliveries for safe retry", async () => {
  const store = await read("src/social-store.js");
  assert.match(store, /CREATE TABLE IF NOT EXISTS social_posts/u);
  assert.match(store, /CREATE TABLE IF NOT EXISTS social_deliveries/u);
  assert.match(store, /CREATE TABLE IF NOT EXISTS social_publish_events/u);
  assert.match(store, /current\.status !== "FAILED"/u);
});
