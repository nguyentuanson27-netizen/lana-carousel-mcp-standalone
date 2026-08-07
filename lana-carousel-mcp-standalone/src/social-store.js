import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { decryptSecret, encryptSecret } from "./social-crypto.js";

const now = () => new Date().toISOString();

db.exec(`
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('facebook','instagram','tiktok')),
  external_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(platform, external_account_id)
);

CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK(content_type IN ('carousel','video')),
  caption TEXT NOT NULL DEFAULT '',
  captions TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'QUEUED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_project ON social_posts(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS social_deliveries (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES social_accounts(id) ON DELETE SET NULL,
  platform TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT,
  remote_url TEXT,
  provider_state TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_social_deliveries_post ON social_deliveries(post_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_social_deliveries_status ON social_deliveries(status, created_at ASC);

CREATE TABLE IF NOT EXISTS social_publish_events (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  delivery_id TEXT REFERENCES social_deliveries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_events_post ON social_publish_events(post_id, created_at ASC);
`);

const statements = {
  upsertAccount: db.prepare(`
    INSERT INTO social_accounts (
      id,platform,external_account_id,account_name,access_token_encrypted,refresh_token_encrypted,
      token_expires_at,scopes,metadata,status,created_at,updated_at
    ) VALUES (
      @id,@platform,@external_account_id,@account_name,@access_token_encrypted,@refresh_token_encrypted,
      @token_expires_at,@scopes,@metadata,'ACTIVE',@created_at,@updated_at
    )
    ON CONFLICT(platform, external_account_id) DO UPDATE SET
      account_name=excluded.account_name,
      access_token_encrypted=excluded.access_token_encrypted,
      refresh_token_encrypted=CASE WHEN excluded.refresh_token_encrypted IS NULL THEN social_accounts.refresh_token_encrypted ELSE excluded.refresh_token_encrypted END,
      token_expires_at=excluded.token_expires_at,
      scopes=excluded.scopes,
      metadata=excluded.metadata,
      status='ACTIVE',
      updated_at=excluded.updated_at
  `),
  getAccountByPlatformExternal: db.prepare(`SELECT * FROM social_accounts WHERE platform=? AND external_account_id=?`),
  getAccount: db.prepare(`SELECT * FROM social_accounts WHERE id=?`),
  listAccounts: db.prepare(`SELECT * FROM social_accounts WHERE status='ACTIVE' ORDER BY platform, account_name`),
  deleteAccount: db.prepare(`DELETE FROM social_accounts WHERE id=?`),
  updateTokens: db.prepare(`UPDATE social_accounts SET access_token_encrypted=?,refresh_token_encrypted=?,token_expires_at=?,scopes=?,updated_at=? WHERE id=?`),
  createPost: db.prepare(`INSERT INTO social_posts (id,project_id,content_type,caption,captions,status,created_at,updated_at) VALUES (@id,@project_id,@content_type,@caption,@captions,@status,@created_at,@updated_at)`),
  createDelivery: db.prepare(`INSERT INTO social_deliveries (id,post_id,account_id,platform,account_name,status,attempt_count,provider_state,error,created_at,updated_at) VALUES (@id,@post_id,@account_id,@platform,@account_name,@status,0,'{}',NULL,@created_at,@updated_at)`),
  getPost: db.prepare(`SELECT * FROM social_posts WHERE id=?`),
  listPosts: db.prepare(`SELECT * FROM social_posts WHERE project_id=? ORDER BY created_at DESC LIMIT ?`),
  getDelivery: db.prepare(`SELECT * FROM social_deliveries WHERE id=?`),
  getDeliveries: db.prepare(`SELECT * FROM social_deliveries WHERE post_id=? ORDER BY created_at ASC`),
  getRunnableDeliveries: db.prepare(`SELECT * FROM social_deliveries WHERE status='QUEUED' ORDER BY created_at ASC LIMIT ?`),
  updateDelivery: db.prepare(`UPDATE social_deliveries SET status=@status,attempt_count=@attempt_count,remote_id=@remote_id,remote_url=@remote_url,provider_state=@provider_state,error=@error,updated_at=@updated_at,completed_at=@completed_at WHERE id=@id`),
  updatePostStatus: db.prepare(`UPDATE social_posts SET status=?,updated_at=? WHERE id=?`),
  insertEvent: db.prepare(`INSERT INTO social_publish_events (id,post_id,delivery_id,event_type,payload,created_at) VALUES (?,?,?,?,?,?)`)
};

function json(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function mapAccount(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    externalAccountId: row.external_account_id,
    accountName: row.account_name,
    tokenExpiresAt: row.token_expires_at,
    scopes: json(row.scopes, []),
    metadata: json(row.metadata, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(includeSecrets ? {
      accessToken: decryptSecret(row.access_token_encrypted),
      refreshToken: row.refresh_token_encrypted ? decryptSecret(row.refresh_token_encrypted) : ""
    } : {})
  };
}

function mapDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    postId: row.post_id,
    accountId: row.account_id,
    platform: row.platform,
    accountName: row.account_name,
    status: row.status,
    attemptCount: row.attempt_count,
    remoteId: row.remote_id,
    remoteUrl: row.remote_url,
    providerState: json(row.provider_state, {}),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function mapPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    contentType: row.content_type,
    caption: row.caption,
    captions: json(row.captions, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveries: statements.getDeliveries.all(row.id).map(mapDelivery)
  };
}

export function upsertSocialAccount({
  platform, externalAccountId, accountName, accessToken, refreshToken = "",
  tokenExpiresAt = null, scopes = [], metadata = {}
}) {
  const existing = statements.getAccountByPlatformExternal.get(platform, externalAccountId);
  const timestamp = now();
  const id = existing?.id || randomUUID();
  statements.upsertAccount.run({
    id,
    platform,
    external_account_id: externalAccountId,
    account_name: accountName || `${platform} ${externalAccountId}`,
    access_token_encrypted: encryptSecret(accessToken),
    refresh_token_encrypted: refreshToken ? encryptSecret(refreshToken) : null,
    token_expires_at: tokenExpiresAt,
    scopes: JSON.stringify(scopes || []),
    metadata: JSON.stringify(metadata || {}),
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp
  });
  return getSocialAccount(id);
}

export function getSocialAccount(id, options = {}) {
  return mapAccount(statements.getAccount.get(id), options);
}

export function listSocialAccounts() {
  return statements.listAccounts.all().map(mapAccount);
}

export function deleteSocialAccount(id) {
  return statements.deleteAccount.run(id).changes > 0;
}

export function updateSocialAccountTokens(id, { accessToken, refreshToken = "", tokenExpiresAt = null, scopes = [] }) {
  const current = statements.getAccount.get(id);
  if (!current) return null;
  statements.updateTokens.run(
    encryptSecret(accessToken),
    refreshToken ? encryptSecret(refreshToken) : current.refresh_token_encrypted,
    tokenExpiresAt,
    JSON.stringify(scopes || json(current.scopes, [])),
    now(),
    id
  );
  return getSocialAccount(id, { includeSecrets: true });
}

export function createSocialPost({ projectId, contentType, caption = "", captions = {}, accounts }) {
  const timestamp = now();
  const id = randomUUID();
  db.transaction(() => {
    statements.createPost.run({
      id,
      project_id: projectId,
      content_type: contentType,
      caption,
      captions: JSON.stringify(captions || {}),
      status: "QUEUED",
      created_at: timestamp,
      updated_at: timestamp
    });
    for (const account of accounts) statements.createDelivery.run({
      id: randomUUID(),
      post_id: id,
      account_id: account.id,
      platform: account.platform,
      account_name: account.accountName,
      status: "QUEUED",
      created_at: timestamp,
      updated_at: timestamp
    });
    statements.insertEvent.run(randomUUID(), id, null, "POST_QUEUED", JSON.stringify({ accountCount: accounts.length, contentType }), timestamp);
  })();
  return getSocialPost(id);
}

export function getSocialPost(id) {
  return mapPost(statements.getPost.get(id));
}

export function listSocialPosts(projectId, limit = 20) {
  return statements.listPosts.all(projectId, Math.max(1, Math.min(100, Number(limit) || 20))).map(mapPost);
}

export function getSocialDelivery(id) {
  return mapDelivery(statements.getDelivery.get(id));
}

export function listRunnableDeliveries(limit = 10) {
  return statements.getRunnableDeliveries.all(Math.max(1, Math.min(50, limit))).map(mapDelivery);
}

export function updateSocialDelivery(id, patch) {
  const current = getSocialDelivery(id);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    id,
    attemptCount: patch.attemptCount ?? current.attemptCount,
    providerState: patch.providerState ?? current.providerState,
    updatedAt: now()
  };
  statements.updateDelivery.run({
    id,
    status: next.status,
    attempt_count: next.attemptCount,
    remote_id: next.remoteId || null,
    remote_url: next.remoteUrl || null,
    provider_state: JSON.stringify(next.providerState || {}),
    error: next.error || null,
    updated_at: next.updatedAt,
    completed_at: next.completedAt || null
  });
  return getSocialDelivery(id);
}

export function resetSocialDeliveryForRetry(id) {
  const current = getSocialDelivery(id);
  if (!current || current.status !== "FAILED") return null;
  return updateSocialDelivery(id, { status: "QUEUED", error: null, completedAt: null });
}

export function recomputeSocialPostStatus(postId) {
  const post = getSocialPost(postId);
  if (!post) return null;
  const statuses = post.deliveries.map(item => item.status);
  let status = "QUEUED";
  if (statuses.some(value => ["PROCESSING", "UPLOADING"].includes(value))) status = "PROCESSING";
  else if (statuses.some(value => value === "QUEUED")) status = "QUEUED";
  else if (statuses.some(value => value === "FAILED")) status = statuses.every(value => value === "FAILED") ? "FAILED" : "PARTIAL";
  else if (statuses.some(value => value === "AWAITING_USER")) status = statuses.every(value => value === "AWAITING_USER") ? "AWAITING_USER" : "PARTIAL";
  else if (statuses.length && statuses.every(value => value === "PUBLISHED")) status = "PUBLISHED";
  statements.updatePostStatus.run(status, now(), postId);
  return getSocialPost(postId);
}

export function recordSocialEvent(postId, deliveryId, eventType, payload = {}) {
  statements.insertEvent.run(randomUUID(), postId, deliveryId || null, eventType, JSON.stringify(payload || {}), now());
}
