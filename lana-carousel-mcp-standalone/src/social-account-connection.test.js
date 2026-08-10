import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
const rootPath = fileURLToPath(root);
const read = relativePath => fs.readFile(new URL(relativePath, root), "utf8");
const configModule = await import("./social-config.js");
const oauthModule = await import("./social-oauth.js");
const storeModule = await import("./social-store.js");

function runFresh(script, env) {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: rootPath,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

async function createFacebookLifecycleFixture() {
  const lifecycleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-social-facebook-lifecycle-"));
  const databasePath = path.join(lifecycleRoot, "lana.sqlite");
  const assetDirectory = path.join(lifecycleRoot, "assets");
  await fs.mkdir(assetDirectory, { recursive: true });
  const baseEnv = {
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://content.example",
    DATABASE_PATH: databasePath,
    ASSET_DIRECTORY: assetDirectory,
    SOCIAL_TOKEN_ENCRYPTION_KEY: "d".repeat(64),
    SOCIAL_OAUTH_STATE_SECRET: "e".repeat(64),
    SOCIAL_MEDIA_SIGNING_SECRET: "f".repeat(64),
    INSTAGRAM_APP_ID: "",
    INSTAGRAM_APP_SECRET: "",
    TIKTOK_CLIENT_KEY: "",
    TIKTOK_CLIENT_SECRET: ""
  };
  const initial = runFresh(`
    const { createProject } = await import("./src/service-core.js");
    const { ensureConfiguredFacebookPageAccount } = await import("./src/social-oauth.js");
    const { createSocialPost } = await import("./src/social-store.js");
    const project = createProject({ title: "Facebook lifecycle" });
    const account = ensureConfiguredFacebookPageAccount();
    const post = createSocialPost({
      projectId: project.id,
      contentType: "carousel",
      mediaSnapshot: { snapshotId: "stale-facebook", images: [] },
      accounts: [account]
    });
    console.log(JSON.stringify({ projectId: project.id, accountId: account.id, deliveryId: post.deliveries[0].id }));
  `, {
    ...baseEnv,
    FACEBOOK_PAGE_ID: "page-a",
    FACEBOOK_PAGE_NAME: "Page A",
    FACEBOOK_PAGE_ACCESS_TOKEN: "page-a-token"
  });
  return { ...initial, baseEnv };
}

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
  const browserSafe = storeModule.listSocialAccounts().find(item => item.id === account.id);
  assert.ok(browserSafe);
  assert.equal(JSON.stringify(browserSafe).includes("internal-page-token"), false, "Page token must never be returned in account listings");
});

test("active env-managed Facebook Page cannot be disconnected through Social Publisher", async () => {
  const account = oauthModule.ensureConfiguredFacebookPageAccount();
  const { disconnectSocialAccount } = await import("./social-service.js");
  assert.throws(
    () => disconnectSocialAccount(account.id),
    error => error?.code === "SOCIAL_ACCOUNT_MANAGED_BY_ENV" && error?.status === 409
  );
  assert.ok(storeModule.getSocialAccount(account.id));
});

test("stale env-managed Facebook account becomes removable after env ownership ends", async () => {
  const service = await read("src/social-service.js");
  assert.match(service, /function isActiveEnvFacebookAccount\(account, feature = socialFeatureStatus\(\)\)/u);
  assert.match(service, /feature\.facebookPageReady === true/u);
  assert.match(service, /account\.externalAccountId === socialConfig\.facebookPageId/u);
  assert.match(service, /staleManagedByEnv:\s*true/u);
  assert.match(service, /if \(isActiveEnvFacebookAccount\(account\)\)/u);
  assert.doesNotMatch(service, /if \(account\.metadata\?\.managedByEnv === true\) \{/u);
});

test("stale Facebook credential cannot publish after Page ID changes but remains disconnectable", async () => {
  const fixture = await createFacebookLifecycleFixture();
  const result = runFresh(`
    const { socialOverview, createPublishPost, processSocialDelivery, disconnectSocialAccount } = await import("./src/social-service.js");
    const { getSocialAccount } = await import("./src/social-store.js");
    const overview = socialOverview(${JSON.stringify(fixture.projectId)});
    const stale = overview.accounts.find(account => account.id === ${JSON.stringify(fixture.accountId)});
    let createCode = null;
    let deliveryCode = null;
    try {
      await createPublishPost({ projectId: ${JSON.stringify(fixture.projectId)}, contentType: "carousel", accountIds: [${JSON.stringify(fixture.accountId)}] });
    } catch (error) {
      createCode = error?.code || null;
    }
    try {
      await processSocialDelivery(${JSON.stringify(fixture.deliveryId)});
    } catch (error) {
      deliveryCode = error?.code || null;
    }
    const disconnected = disconnectSocialAccount(${JSON.stringify(fixture.accountId)});
    console.log(JSON.stringify({
      staleManagedByEnv: stale?.metadata?.staleManagedByEnv === true,
      createCode,
      deliveryCode,
      disconnected: disconnected.success === true,
      removed: getSocialAccount(${JSON.stringify(fixture.accountId)}) == null
    }));
  `, {
    ...fixture.baseEnv,
    FACEBOOK_PAGE_ID: "page-b",
    FACEBOOK_PAGE_NAME: "Page B",
    FACEBOOK_PAGE_ACCESS_TOKEN: "page-b-token"
  });
  assert.equal(result.staleManagedByEnv, true);
  assert.equal(result.createCode, "SOCIAL_FACEBOOK_CREDENTIAL_STALE");
  assert.equal(result.deliveryCode, "SOCIAL_FACEBOOK_CREDENTIAL_STALE");
  assert.equal(result.disconnected, true);
  assert.equal(result.removed, true);
});

test("stale Facebook credential cannot publish after env removal", async () => {
  const fixture = await createFacebookLifecycleFixture();
  const result = runFresh(`
    const { socialOverview, createPublishPost } = await import("./src/social-service.js");
    const overview = socialOverview(${JSON.stringify(fixture.projectId)});
    const stale = overview.accounts.find(account => account.id === ${JSON.stringify(fixture.accountId)});
    let createCode = null;
    try {
      await createPublishPost({ projectId: ${JSON.stringify(fixture.projectId)}, contentType: "carousel", accountIds: [${JSON.stringify(fixture.accountId)}] });
    } catch (error) {
      createCode = error?.code || null;
    }
    console.log(JSON.stringify({
      facebookPageReady: overview.feature.facebookPageReady,
      staleManagedByEnv: stale?.metadata?.staleManagedByEnv === true,
      createCode
    }));
  `, {
    ...fixture.baseEnv,
    FACEBOOK_PAGE_ID: "",
    FACEBOOK_PAGE_NAME: "",
    FACEBOOK_PAGE_ACCESS_TOKEN: ""
  });
  assert.equal(result.facebookPageReady, false);
  assert.equal(result.staleManagedByEnv, true);
  assert.equal(result.createCode, "SOCIAL_FACEBOOK_CREDENTIAL_STALE");
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

test("legacy Facebook-linked Instagram credentials cannot be selected or published after migration", async () => {
  const [service, ui] = await Promise.all([
    read("src/social-service.js"),
    read("public/social-studio.js")
  ]);
  assert.match(service, /function isLegacyInstagramAccount\(account\)/u);
  assert.match(service, /metadata\?\.credentialSource !== "instagram-login"/u);
  assert.match(service, /accounts\.some\(isLegacyInstagramAccount\)/u);
  assert.match(service, /INSTAGRAM_RECONNECT_REQUIRED/u);
  assert.match(ui, /const selectable = accounts\.filter\(account => !isLegacyInstagramAccount\(account\)\)/u);
  assert.match(ui, /Cần kết nối lại/u);
  assert.match(ui, /legacyInstagram \? "disabled"/u);
});

test("Instagram token exchange and refresh stay on Instagram-owned endpoints", async () => {
  const oauth = await read("src/social-oauth.js");
  assert.match(oauth, /https:\/\/api\.instagram\.com\/oauth\/access_token/u);
  assert.match(oauth, /https:\/\/graph\.instagram\.com\/access_token/u);
  assert.match(oauth, /grant_type:\s*"ig_exchange_token"/u);
  assert.match(oauth, /https:\/\/graph\.instagram\.com\/refresh_access_token/u);
  assert.match(oauth, /grant_type:\s*"ig_refresh_token"/u);
});

test("Instagram publishing is isolated onto graph.instagram.com", async () => {
  const provider = await read("src/social-provider-meta.js");
  assert.match(provider, /https:\/\/graph\.instagram\.com/u);
  assert.match(provider, /https:\/\/graph\.facebook\.com/u);
  assert.match(provider, /account\.platform === "instagram"/u);
});

test("Social UI separates internal Facebook from Instagram OAuth", async () => {
  const [ui, routes, env] = await Promise.all([
    read("public/social-studio.js"),
    read("src/social-routes.js"),
    read(".env.example")
  ]);
  assert.doesNotMatch(ui, /data-social-connect="meta"/u);
  assert.match(ui, /data-social-connect="instagram"/u);
  assert.match(ui, /Facebook nội bộ/u);
  assert.match(ui, /managedByEnv/u);
  assert.match(routes, /z\.enum\(\["instagram",\s*"tiktok"\]\)/u);
  assert.match(routes, /\/social\/oauth\/instagram\/callback/u);
  assert.match(env, /FACEBOOK_PAGE_ACCESS_TOKEN=/u);
  assert.match(env, /INSTAGRAM_APP_ID=/u);
  assert.doesNotMatch(env, /META_APP_ID=/u);
});
