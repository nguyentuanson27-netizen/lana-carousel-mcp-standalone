import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db, sql } from "./db.js";
import { AppError } from "./errors.js";
import { currentQuotaClientId, normalizeQuotaClientId } from "./quota-principal.js";

db.exec(`
CREATE TABLE IF NOT EXISTS resource_access_tokens (
  token_hash TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  quota_client_id TEXT NOT NULL DEFAULT 'mcp:anonymous',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_access_tokens_expiry ON resource_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_resource_access_tokens_resource ON resource_access_tokens(resource_type,resource_id);

CREATE TABLE IF NOT EXISTS resource_sessions (
  session_hash TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  quota_client_id TEXT NOT NULL DEFAULT 'mcp:anonymous',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resource_sessions_expiry ON resource_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_resource_sessions_resource ON resource_sessions(resource_type,resource_id);

CREATE TABLE IF NOT EXISTS browser_admin_sessions (
  session_hash TEXT PRIMARY KEY,
  quota_client_id TEXT NOT NULL DEFAULT 'mcp:anonymous',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_admin_sessions_expiry ON browser_admin_sessions(expires_at);
`);

function ensureColumn(table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name));
  if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("resource_access_tokens", "quota_client_id", "TEXT NOT NULL DEFAULT 'mcp:anonymous'");
ensureColumn("resource_sessions", "quota_client_id", "TEXT NOT NULL DEFAULT 'mcp:anonymous'");
ensureColumn("browser_admin_sessions", "quota_client_id", "TEXT NOT NULL DEFAULT 'mcp:anonymous'");

db.exec(`
CREATE TABLE IF NOT EXISTS resource_session_grants (
  session_hash TEXT NOT NULL REFERENCES resource_sessions(session_hash) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  quota_client_id TEXT NOT NULL DEFAULT 'mcp:anonymous',
  granted_at TEXT NOT NULL,
  PRIMARY KEY (session_hash, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_session_grants_resource
  ON resource_session_grants(resource_type,resource_id);

INSERT OR IGNORE INTO resource_session_grants
  (session_hash,resource_type,resource_id,quota_client_id,granted_at)
SELECT session_hash,resource_type,resource_id,quota_client_id,created_at
FROM resource_sessions;
`);

const accessSql = {
  createToken: db.prepare(`INSERT INTO resource_access_tokens (token_hash,resource_type,resource_id,quota_client_id,expires_at,used_at,created_at) VALUES (@token_hash,@resource_type,@resource_id,@quota_client_id,@expires_at,NULL,@created_at)`),
  getToken: db.prepare(`SELECT * FROM resource_access_tokens WHERE token_hash=?`),
  consumeToken: db.prepare(`UPDATE resource_access_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND datetime(expires_at)>datetime(?)`),
  createSession: db.prepare(`INSERT INTO resource_sessions (session_hash,resource_type,resource_id,quota_client_id,expires_at,created_at) VALUES (@session_hash,@resource_type,@resource_id,@quota_client_id,@expires_at,@created_at)`),
  getSession: db.prepare(`SELECT * FROM resource_sessions WHERE session_hash=? AND datetime(expires_at)>datetime(?)`),
  refreshSession: db.prepare(`UPDATE resource_sessions SET expires_at=? WHERE session_hash=? AND datetime(expires_at)>datetime(?)`),
  addGrant: db.prepare(`INSERT INTO resource_session_grants (session_hash,resource_type,resource_id,quota_client_id,granted_at) VALUES (@session_hash,@resource_type,@resource_id,@quota_client_id,@granted_at) ON CONFLICT(session_hash,resource_type,resource_id) DO UPDATE SET quota_client_id=excluded.quota_client_id,granted_at=excluded.granted_at`),
  getGrant: db.prepare(`SELECT * FROM resource_session_grants WHERE session_hash=? AND resource_type=? AND resource_id=?`),
  getFirstGrant: db.prepare(`SELECT * FROM resource_session_grants WHERE session_hash=? AND resource_type=? ORDER BY granted_at ASC LIMIT 1`),
  listGrants: db.prepare(`SELECT * FROM resource_session_grants WHERE session_hash=? ORDER BY granted_at ASC`),
  createAdminSession: db.prepare(`INSERT INTO browser_admin_sessions (session_hash,quota_client_id,expires_at,created_at) VALUES (@session_hash,@quota_client_id,@expires_at,@created_at)`),
  getAdminSession: db.prepare(`SELECT * FROM browser_admin_sessions WHERE session_hash=? AND datetime(expires_at)>datetime(?)`),
  purgeTokens: db.prepare(`DELETE FROM resource_access_tokens WHERE used_at IS NOT NULL OR datetime(expires_at)<=datetime(?)`),
  purgeSessions: db.prepare(`DELETE FROM resource_sessions WHERE datetime(expires_at)<=datetime(?)`),
  purgeAdminSessions: db.prepare(`DELETE FROM browser_admin_sessions WHERE datetime(expires_at)<=datetime(?)`)
};

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const allowedResourceTypes = new Set(["carousel", "video-analysis"]);

function assertResource(resourceType, resourceId) {
  if (!allowedResourceTypes.has(resourceType)) {
    throw new AppError("RESOURCE_TYPE_INVALID", "Loại dự án không hợp lệ.", 400);
  }
  if (!resourceId) throw new AppError("RESOURCE_ID_REQUIRED", "Thiếu mã dự án.", 400);

  if (resourceType === "carousel") {
    if (!sql.getProject.get(resourceId)) throw new AppError("PROJECT_NOT_FOUND", "Không tìm thấy dự án.", 404);
    return;
  }

  let exists = false;
  try {
    exists = Boolean(db.prepare(`SELECT 1 FROM video_analysis_projects WHERE id=?`).get(resourceId));
  } catch {
    exists = false;
  }
  if (!exists) throw new AppError("VIDEO_ANALYSIS_NOT_FOUND", "Không tìm thấy dự án phân tích video.", 404);
}

function issueResourceAccessToken(resourceType, resourceId, quotaClientId = currentQuotaClientId()) {
  assertResource(resourceType, resourceId);
  const accessToken = token();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + config.projectAccessTokenTtlSeconds * 1000).toISOString();
  accessSql.createToken.run({
    token_hash: hash(accessToken),
    resource_type: resourceType,
    resource_id: resourceId,
    quota_client_id: normalizeQuotaClientId(quotaClientId),
    expires_at: expiresAt,
    created_at: createdAt
  });
  return accessToken;
}

function createResourceAccessUrl({ resourceType, resourceId, returnTo, quotaClientId }) {
  const accessToken = issueResourceAccessToken(resourceType, resourceId, quotaClientId);
  const query = new URLSearchParams({ resourceType, resourceId, returnTo });
  return `${config.publicBaseUrl}/resource-auth.html?${query.toString()}#access_token=${encodeURIComponent(accessToken)}`;
}

export function createProjectAccessUrl(projectId, options = {}) {
  const accessToken = issueResourceAccessToken("carousel", projectId, options.quotaClientId);
  return `${config.publicBaseUrl}/widget-auth.html?projectId=${encodeURIComponent(projectId)}#access_token=${encodeURIComponent(accessToken)}`;
}

export function createVideoAnalysisAccessUrl(projectId, options = {}) {
  return createResourceAccessUrl({
    resourceType: "video-analysis",
    resourceId: projectId,
    returnTo: `/video-studio?projectId=${encodeURIComponent(projectId)}`,
    quotaClientId: options.quotaClientId
  });
}

export function exchangeResourceAccessToken(accessToken, expectedResourceType, expectedResourceId, existingSessionToken = "") {
  if (!accessToken) throw new AppError("ACCESS_TOKEN_REQUIRED", "Thiếu token mở dự án.", 401);
  const tokenHash = hash(accessToken);
  const timestamp = now();

  return db.transaction(() => {
    const record = accessSql.getToken.get(tokenHash);
    if (!record || record.used_at || Date.parse(record.expires_at) <= Date.now()) {
      throw new AppError("ACCESS_TOKEN_INVALID", "Link mở dự án đã hết hạn hoặc đã được sử dụng.", 401);
    }
    if (expectedResourceType && record.resource_type !== expectedResourceType) {
      throw new AppError("ACCESS_TOKEN_TYPE_MISMATCH", "Token không thuộc loại dự án này.", 403);
    }
    if (expectedResourceId && record.resource_id !== expectedResourceId) {
      throw new AppError("ACCESS_TOKEN_PROJECT_MISMATCH", "Token không thuộc dự án này.", 403);
    }
    assertResource(record.resource_type, record.resource_id);

    if (accessSql.consumeToken.run(timestamp, tokenHash, timestamp).changes !== 1) {
      throw new AppError("ACCESS_TOKEN_INVALID", "Link mở dự án đã hết hạn hoặc đã được sử dụng.", 401);
    }

    const expiresAt = new Date(Date.now() + config.projectSessionTtlSeconds * 1000).toISOString();
    const existingHash = existingSessionToken ? hash(existingSessionToken) : "";
    const existing = existingHash ? accessSql.getSession.get(existingHash, timestamp) : null;
    const sessionToken = existing ? existingSessionToken : token();
    const sessionHash = existing ? existing.session_hash : hash(sessionToken);
    const quotaClientId = normalizeQuotaClientId(record.quota_client_id);

    if (existing) {
      accessSql.refreshSession.run(expiresAt, sessionHash, timestamp);
    } else {
      accessSql.createSession.run({
        session_hash: sessionHash,
        resource_type: record.resource_type,
        resource_id: record.resource_id,
        quota_client_id: quotaClientId,
        expires_at: expiresAt,
        created_at: timestamp
      });
    }

    accessSql.addGrant.run({
      session_hash: sessionHash,
      resource_type: record.resource_type,
      resource_id: record.resource_id,
      quota_client_id: quotaClientId,
      granted_at: timestamp
    });

    return {
      sessionToken,
      resourceType: record.resource_type,
      resourceId: record.resource_id,
      quotaClientId,
      expiresAt
    };
  })();
}

export function exchangeProjectAccessToken(accessToken, expectedProjectId, existingSessionToken = "") {
  return exchangeResourceAccessToken(accessToken, "carousel", expectedProjectId, existingSessionToken);
}

export function getResourceSession(sessionToken) {
  if (!sessionToken) return null;
  return accessSql.getSession.get(hash(sessionToken), now()) || null;
}

export function getResourceSessionGrant(session, resourceType, resourceId) {
  if (!session?.session_hash || !resourceType || !resourceId) return null;
  return accessSql.getGrant.get(session.session_hash, resourceType, resourceId) || null;
}

export function listResourceSessionGrants(session) {
  if (!session?.session_hash) return [];
  return accessSql.listGrants.all(session.session_hash);
}

export function getProjectSession(sessionToken) {
  const session = getResourceSession(sessionToken);
  if (!session) return null;
  const grant = accessSql.getFirstGrant.get(session.session_hash, "carousel");
  if (!grant) return null;
  return { ...session, project_id: grant.resource_id, quota_client_id: grant.quota_client_id };
}

export function createBrowserAdminSession(quotaClientId = currentQuotaClientId("admin:anonymous")) {
  const sessionToken = token();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + config.projectSessionTtlSeconds * 1000).toISOString();
  accessSql.createAdminSession.run({
    session_hash: hash(sessionToken),
    quota_client_id: normalizeQuotaClientId(quotaClientId, "admin:anonymous"),
    expires_at: expiresAt,
    created_at: createdAt
  });
  return { sessionToken, expiresAt };
}

export function getBrowserAdminSession(sessionToken) {
  if (!sessionToken) return null;
  return accessSql.getAdminSession.get(hash(sessionToken), now()) || null;
}

export function purgeProjectAccess() {
  const timestamp = now();
  accessSql.purgeTokens.run(timestamp);
  accessSql.purgeSessions.run(timestamp);
  accessSql.purgeAdminSessions.run(timestamp);
}

purgeProjectAccess();
setInterval(purgeProjectAccess, 15 * 60_000).unref();
