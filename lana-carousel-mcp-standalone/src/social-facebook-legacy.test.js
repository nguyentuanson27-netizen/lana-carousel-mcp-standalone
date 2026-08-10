import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

function runFresh(script, env) {
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: rootPath,
    env,
    encoding: "utf8"
  });
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test("pre-migration Facebook OAuth account is cleanup-only after internal Page migration", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lana-social-legacy-facebook-"));
  const databasePath = path.join(tempRoot, "lana.sqlite");
  const assetDirectory = path.join(tempRoot, "assets");
  await fs.mkdir(assetDirectory, { recursive: true });

  const baseEnv = {
    ...process.env,
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://content.example",
    DATABASE_PATH: databasePath,
    ASSET_DIRECTORY: assetDirectory,
    SOCIAL_TOKEN_ENCRYPTION_KEY: "7".repeat(64),
    SOCIAL_OAUTH_STATE_SECRET: "8".repeat(64),
    SOCIAL_MEDIA_SIGNING_SECRET: "9".repeat(64),
    INSTAGRAM_APP_ID: "",
    INSTAGRAM_APP_SECRET: "",
    TIKTOK_CLIENT_KEY: "",
    TIKTOK_CLIENT_SECRET: ""
  };

  const seeded = runFresh(`
    const { createProject } = await import("./src/service-core.js");
    const { upsertSocialAccount, createSocialPost } = await import("./src/social-store.js");
    const project = createProject({ title: "Legacy Facebook migration" });
    const legacy = upsertSocialAccount({
      platform: "facebook",
      externalAccountId: "legacy-page",
      accountName: "Legacy OAuth Page",
      accessToken: "legacy-oauth-token",
      scopes: ["pages_manage_posts", "pages_read_engagement"],
      metadata: { tasks: ["CREATE_CONTENT"] }
    });
    const post = createSocialPost({
      projectId: project.id,
      contentType: "carousel",
      mediaSnapshot: { snapshotId: "legacy-facebook", images: [] },
      accounts: [legacy]
    });
    console.log(JSON.stringify({ projectId: project.id, accountId: legacy.id, deliveryId: post.deliveries[0].id }));
  `, {
    ...baseEnv,
    FACEBOOK_PAGE_ID: "",
    FACEBOOK_PAGE_NAME: "",
    FACEBOOK_PAGE_ACCESS_TOKEN: ""
  });

  const result = runFresh(`
    const { socialOverview, createPublishPost, processSocialDelivery, disconnectSocialAccount } = await import("./src/social-service.js");
    const { getSocialAccount, getSocialDelivery } = await import("./src/social-store.js");
    const overview = socialOverview(${JSON.stringify(seeded.projectId)});
    const legacy = overview.accounts.find(account => account.id === ${JSON.stringify(seeded.accountId)});
    const activeFacebook = overview.accounts.find(account => account.platform === "facebook" && account.externalAccountId === "current-page");
    let createCode = null;
    let deliveryCode = null;
    try {
      await createPublishPost({
        projectId: ${JSON.stringify(seeded.projectId)},
        contentType: "carousel",
        accountIds: [${JSON.stringify(seeded.accountId)}]
      });
    } catch (error) {
      createCode = error?.code || null;
    }
    try {
      await processSocialDelivery(${JSON.stringify(seeded.deliveryId)});
    } catch (error) {
      deliveryCode = error?.code || null;
    }
    const deliveryStatus = getSocialDelivery(${JSON.stringify(seeded.deliveryId)})?.status || null;
    const disconnected = disconnectSocialAccount(${JSON.stringify(seeded.accountId)});
    console.log(JSON.stringify({
      cleanupOnly: legacy?.metadata?.staleManagedByEnv === true,
      publishable: legacy?.metadata?.publishable,
      legacyManagedByEnv: legacy?.metadata?.managedByEnv,
      activeManagedByEnv: activeFacebook?.metadata?.managedByEnv,
      createCode,
      deliveryCode,
      deliveryStatus,
      disconnected: disconnected.success === true,
      removed: getSocialAccount(${JSON.stringify(seeded.accountId)}) == null
    }));
  `, {
    ...baseEnv,
    FACEBOOK_PAGE_ID: "current-page",
    FACEBOOK_PAGE_NAME: "Current Page",
    FACEBOOK_PAGE_ACCESS_TOKEN: "current-page-token"
  });

  assert.equal(result.cleanupOnly, true);
  assert.equal(result.publishable, false);
  assert.equal(result.legacyManagedByEnv, false);
  assert.equal(result.activeManagedByEnv, true);
  assert.equal(result.createCode, "SOCIAL_FACEBOOK_CREDENTIAL_STALE");
  assert.equal(result.deliveryCode, "SOCIAL_FACEBOOK_CREDENTIAL_STALE");
  assert.equal(result.deliveryStatus, "FAILED");
  assert.equal(result.disconnected, true);
  assert.equal(result.removed, true);
});
