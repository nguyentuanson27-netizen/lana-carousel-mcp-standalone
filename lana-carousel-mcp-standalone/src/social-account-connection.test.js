import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-social-connection-test-"));
process.env.NODE_ENV = "test";
process.env.PUBLIC_BASE_URL = "https://content.example";
process.env.DATABASE_PATH = path.join(tempRoot, "lana.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempRoot, "assets");
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
process.env.SOCIAL_OAUTH_STATE_SECRET = "b".repeat(64);
process.env.SOCIAL_MEDIA_SIGNING_SECRET = "c".repeat(64);
process.env.FACEBOOK_PAGE_ID = "123456789";
process.env.FACEBOOK_PAGE_NAME = "La.na Design";
process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "internal-page-token";
process.env.INSTAGRAM_APP_ID = "987654321";
process.env.INSTAGRAM_APP_SECRET = "instagram-secret";
process.env.TIKTOK_CLIENT_KEY = "tiktok-key";
process.env.TIKTOK_CLIENT_SECRET = "tiktok-secret";
await fs.mkdir(process.env.ASSET_DIRECTORY, { recursive: true });

const root = new URL("../", import.meta.url);
const read = relativePath => fs.readFile(new URL(relativePath, root), "utf8");
const configModule = await import("./social-config.js");
const oauthModule = await import("./social-oauth.js");
const storeModule = await import("./social-store.js");

test("Facebook Page can be provisioned internally without Facebook Login", async () => {
  assert.equal(configModule.socialFeatureStatus().facebookPageReady, true);
  assert.equal(configModule.socialConfig.facebookPageId, "123456789");
  assert.equal(configModule.socialConfig.facebookPageName, "La.na Design");
  assert.equal(configModule.socialConfig.facebookPageAccessToken, "internal-page-token");
  assert.equal(typeof oauthModule.metaOAuthUrl, "undefined", "public Facebook OAuth should no longer be exposed");

  assert.equal(typeof oauthModule.ensureConfiguredFacebookPageAccount, "function");
  const account = oauthModule.ensureConfiguredFacebookPageAccount();
  assert.equal(account.platform, "facebook");
  assert.equal(account.externalAccountId, "123456789");
  assert.equal(account.accountName, "La.na Design");
  assert.equal(account.metadata.credentialSource, "env");
  assert.equal(account.metadata.managedByEnv, true);

  const stored = storeModule.getSocialAccount(account.id, { includeSecrets: true });
  assert.equal(stored.accessToken, "internal-page-token");
});

test("Instagram uses Business Login for Instagram instead of Facebook Login", () => {
  assert.equal(configModule.socialFeatureStatus().instagramOAuthReady, true);
  assert.equal(configModule.socialConfig.instagramRedirectUri, "https://content.example/social/oauth/instagram/callback");
  assert.equal(typeof oauthModule.instagramOAuthUrl, "function");

  const url = new URL(oauthModule.instagramOAuthUrl("project-123"));
  assert.equal(url.origin, "https://www.instagram.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "987654321");
  assert.equal(url.searchParams.get("redirect_uri"), "https://content.example/social/oauth/instagram/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("enable_fb_login"), "0");
  assert.deepEqual(new Set(String(url.searchParams.get("scope") || "").split(",")), new Set([
    "instagram_business_basic",
    "instagram_business_content_publish"
  ]));
});

test("Instagram publishing is isolated onto graph.instagram.com", async () => {
  const provider = await read("src/social-provider-meta.js");
  assert.match(provider, /https:\/\/graph\.instagram\.com/u);
  assert.match(provider, /https:\/\/graph\.facebook\.com/u);
  assert.match(provider, /account\.platform === "instagram"/u);
});

test("Social UI separates internal Facebook from Instagram OAuth", async () => {
  const [ui, routes] = await Promise.all([
    read("public/social-studio.js"),
    read("src/social-routes.js")
  ]);
  assert.doesNotMatch(ui, /data-social-connect="meta"/u);
  assert.match(ui, /data-social-connect="instagram"/u);
  assert.match(ui, /Facebook nội bộ/u);
  assert.match(ui, /managedByEnv/u);
  assert.match(routes, /z\.enum\(\["instagram",\s*"tiktok"\]\)/u);
  assert.match(routes, /\/social\/oauth\/instagram\/callback/u);
});
