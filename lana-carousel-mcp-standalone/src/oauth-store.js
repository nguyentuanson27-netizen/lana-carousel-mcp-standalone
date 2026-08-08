import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { AppError } from "./errors.js";

db.exec(`
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_login_states (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_consent_requests (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  oauth_state TEXT,
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  quota_client_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  quota_client_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_refresh_token_lineage (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  replaced_by_hash TEXT,
  family_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_login_states_expiry ON oauth_login_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_consent_expiry ON oauth_consent_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_authorization_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_expiry ON oauth_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expiry ON oauth_refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_lineage_family ON oauth_refresh_token_lineage(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_lineage_expiry ON oauth_refresh_token_lineage(family_expires_at);
`);

const sql = {
  createClient: db.prepare(`INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES(@client_id,@client_name,@redirect_uris,@created_at)`),
  getClient: db.prepare(`SELECT * FROM oauth_clients WHERE client_id=?`),
  createLoginState: db.prepare(`INSERT INTO oauth_login_states(state_hash,return_to,expires_at,used_at,created_at) VALUES(@state_hash,@return_to,@expires_at,NULL,@created_at)`),
  getLoginState: db.prepare(`SELECT * FROM oauth_login_states WHERE state_hash=?`),
  consumeLoginState: db.prepare(`UPDATE oauth_login_states SET used_at=? WHERE state_hash=? AND used_at IS NULL AND datetime(expires_at)>datetime(?)`),
  createConsent: db.prepare(`INSERT INTO oauth_consent_requests(token_hash,client_id,redirect_uri,code_challenge,resource,scope,oauth_state,subject,expires_at,used_at,created_at) VALUES(@token_hash,@client_id,@redirect_uri,@code_challenge,@resource,@scope,@oauth_state,@subject,@expires_at,NULL,@created_at)`),
  getConsent: db.prepare(`SELECT * FROM oauth_consent_requests WHERE token_hash=?`),
  consumeConsent: db.prepare(`UPDATE oauth_consent_requests SET used_at=? WHERE token_hash=? AND used_at IS NULL AND datetime(expires_at)>datetime(?)`),
  createCode: db.prepare(`INSERT INTO oauth_authorization_codes(code_hash,client_id,redirect_uri,code_challenge,resource,scope,subject,expires_at,used_at,created_at) VALUES(@code_hash,@client_id,@redirect_uri,@code_challenge,@resource,@scope,@subject,@expires_at,NULL,@created_at)`),
  getCode: db.prepare(`SELECT * FROM oauth_authorization_codes WHERE code_hash=?`),
  consumeCode: db.prepare(`UPDATE oauth_authorization_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND datetime(expires_at)>datetime(?)`),
  createAccess: db.prepare(`INSERT INTO oauth_access_tokens(token_hash,client_id,subject,resource,scope,quota_client_id,expires_at,created_at) VALUES(@token_hash,@client_id,@subject,@resource,@scope,@quota_client_id,@expires_at,@created_at)`),
  getAccess: db.prepare(`SELECT * FROM oauth_access_tokens WHERE token_hash=? AND datetime(expires_at)>datetime(?)`),
  createRefresh: db.prepare(`INSERT INTO oauth_refresh_tokens(token_hash,client_id,subject,resource,scope,quota_client_id,expires_at,revoked_at,created_at) VALUES(@token_hash,@client_id,@subject,@resource,@scope,@quota_client_id,@expires_at,NULL,@created_at)`),
  getRefresh: db.prepare(`SELECT * FROM oauth_refresh_tokens WHERE token_hash=?`),
  revokeRefresh: db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL AND datetime(expires_at)>datetime(?)`),
  createRefreshLineage: db.prepare(`INSERT OR IGNORE INTO oauth_refresh_token_lineage(token_hash,family_id,replaced_by_hash,family_expires_at,created_at) VALUES(@token_hash,@family_id,NULL,@family_expires_at,@created_at)`),
  getRefreshLineage: db.prepare(`SELECT * FROM oauth_refresh_token_lineage WHERE token_hash=?`),
  linkRefreshReplacement: db.prepare(`UPDATE oauth_refresh_token_lineage SET replaced_by_hash=? WHERE token_hash=? AND replaced_by_hash IS NULL`),
  extendRefreshFamily: db.prepare(`UPDATE oauth_refresh_token_lineage SET family_expires_at=@family_expires_at WHERE family_id=@family_id AND datetime(family_expires_at)<datetime(@family_expires_at)`),
  revokeRefreshFamily: db.prepare(`UPDATE oauth_refresh_tokens SET revoked_at=COALESCE(revoked_at,@revoked_at) WHERE token_hash IN (SELECT token_hash FROM oauth_refresh_token_lineage WHERE family_id=@family_id)`),
  purgeLoginStates: db.prepare(`DELETE FROM oauth_login_states WHERE used_at IS NOT NULL OR datetime(expires_at)<=datetime(?)`),
  purgeConsent: db.prepare(`DELETE FROM oauth_consent_requests WHERE used_at IS NOT NULL OR datetime(expires_at)<=datetime(?)`),
  purgeCodes: db.prepare(`DELETE FROM oauth_authorization_codes WHERE used_at IS NOT NULL OR datetime(expires_at)<=datetime(?)`),
  purgeAccess: db.prepare(`DELETE FROM oauth_access_tokens WHERE datetime(expires_at)<=datetime(?)`),
  purgeRefresh: db.prepare(`DELETE FROM oauth_refresh_tokens WHERE datetime(expires_at)<=datetime(@timestamp) AND token_hash NOT IN (SELECT token_hash FROM oauth_refresh_token_lineage WHERE datetime(family_expires_at)>datetime(@timestamp))`),
  purgeRefreshLineage: db.prepare(`DELETE FROM oauth_refresh_token_lineage WHERE token_hash NOT IN (SELECT token_hash FROM oauth_refresh_tokens)`)
};

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(String(value)).digest("hex");
const opaque = prefix => `${prefix}_${randomBytes(32).toString("base64url")}`;
const expiresAt = seconds => new Date(Date.now() + seconds * 1000).toISOString();

function oauthError(code, message, status = 400) {
  return new AppError(code, message, status);
}

function json(value, fallback = []) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizedRedirectUri(raw) {
  let value;
  try { value = new URL(String(raw || "")); }
  catch { throw oauthError("invalid_redirect_uri", "redirect_uri không hợp lệ."); }
  if (value.hash || value.username || value.password) throw oauthError("invalid_redirect_uri", "redirect_uri không hợp lệ.");
  const localhost = value.hostname === "localhost" || value.hostname === "127.0.0.1" || value.hostname === "[::1]";
  if (value.protocol !== "https:" && !(value.protocol === "http:" && localhost)) {
    throw oauthError("invalid_redirect_uri", "redirect_uri phải dùng HTTPS, trừ localhost khi phát triển.");
  }
  return value.toString();
}

function normalizeScope(raw) {
  const scopes = [...new Set(String(raw || "mcp").trim().split(/\s+/u).filter(Boolean))];
  if (!scopes.length) scopes.push("mcp");
  if (scopes.some(scope => scope !== "mcp")) throw oauthError("invalid_scope", "Lana MCP hiện chỉ hỗ trợ scope mcp.");
  return scopes.join(" ");
}

export function mcpResourceUri() {
  return `${config.publicBaseUrl}/mcp`;
}

export function registerOAuthClient(metadata = {}) {
  const redirectUris = [...new Set((metadata.redirect_uris || []).map(normalizedRedirectUri))];
  if (!redirectUris.length || redirectUris.length > 10) throw oauthError("invalid_client_metadata", "Cần từ 1 đến 10 redirect_uris.");
  const grantTypes = metadata.grant_types || ["authorization_code", "refresh_token"];
  const responseTypes = metadata.response_types || ["code"];
  if (grantTypes.some(value => !["authorization_code", "refresh_token"].includes(value))) throw oauthError("invalid_client_metadata", "grant_types không được hỗ trợ.");
  if (responseTypes.some(value => value !== "code")) throw oauthError("invalid_client_metadata", "response_types không được hỗ trợ.");
  if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== "none") throw oauthError("invalid_client_metadata", "Lana chỉ hỗ trợ public client + PKCE.");
  const clientId = opaque("client");
  const createdAt = now();
  const clientName = String(metadata.client_name || "MCP client").slice(0, 200);
  sql.createClient.run({ client_id: clientId, client_name: clientName, redirect_uris: JSON.stringify(redirectUris), created_at: createdAt });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(createdAt) / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  };
}

export function getOAuthClient(clientId) {
  const row = sql.getClient.get(String(clientId || ""));
  if (!row) return null;
  return { ...row, redirectUris: json(row.redirect_uris) };
}

export function validateAuthorizationRequest(input = {}) {
  const client = getOAuthClient(input.client_id);
  if (!client) throw oauthError("invalid_client", "OAuth client chưa được đăng ký.");
  const redirectUri = normalizedRedirectUri(input.redirect_uri);
  if (!client.redirectUris.includes(redirectUri)) throw oauthError("invalid_request", "redirect_uri không khớp client đã đăng ký.");
  if (String(input.response_type || "") !== "code") throw oauthError("unsupported_response_type", "Chỉ hỗ trợ response_type=code.");
  const resource = String(input.resource || "");
  if (resource !== mcpResourceUri()) throw oauthError("invalid_target", "resource phải trỏ đúng endpoint Lana MCP.");
  const codeChallenge = String(input.code_challenge || "");
  if (String(input.code_challenge_method || "") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
    throw oauthError("invalid_request", "PKCE S256 là bắt buộc.");
  }
  return {
    clientId: client.client_id,
    clientName: client.client_name,
    redirectUri,
    codeChallenge,
    resource,
    scope: normalizeScope(input.scope),
    state: input.state ? String(input.state) : ""
  };
}

export function createGoogleLoginState(returnTo) {
  const state = opaque("login");
  const createdAt = now();
  sql.createLoginState.run({
    state_hash: hash(state),
    return_to: String(returnTo),
    expires_at: expiresAt(config.oauthLoginStateTtlSeconds),
    created_at: createdAt
  });
  return state;
}

export function consumeGoogleLoginState(state) {
  const stateHash = hash(state);
  const record = sql.getLoginState.get(stateHash);
  const timestamp = now();
  if (!record || record.used_at || Date.parse(record.expires_at) <= Date.now() || sql.consumeLoginState.run(timestamp, stateHash, timestamp).changes !== 1) {
    throw oauthError("OAUTH_LOGIN_STATE_INVALID", "Phiên đăng nhập Google đã hết hạn hoặc không hợp lệ.", 400);
  }
  return record.return_to;
}

export function createConsentRequest(request, subject) {
  const consentToken = opaque("consent");
  const createdAt = now();
  sql.createConsent.run({
    token_hash: hash(consentToken),
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    resource: request.resource,
    scope: request.scope,
    oauth_state: request.state || null,
    subject: String(subject),
    expires_at: expiresAt(config.oauthConsentTtlSeconds),
    created_at: createdAt
  });
  return consentToken;
}

export function consumeConsentRequest(consentToken, subject) {
  const tokenHash = hash(consentToken);
  const record = sql.getConsent.get(tokenHash);
  const timestamp = now();
  if (!record || record.used_at || Date.parse(record.expires_at) <= Date.now() || record.subject !== String(subject) || sql.consumeConsent.run(timestamp, tokenHash, timestamp).changes !== 1) {
    throw oauthError("invalid_request", "Yêu cầu cấp quyền đã hết hạn hoặc không hợp lệ.");
  }
  return record;
}

export function issueAuthorizationCode(consent) {
  const code = opaque("code");
  const createdAt = now();
  sql.createCode.run({
    code_hash: hash(code),
    client_id: consent.client_id,
    redirect_uri: consent.redirect_uri,
    code_challenge: consent.code_challenge,
    resource: consent.resource,
    scope: consent.scope,
    subject: consent.subject,
    expires_at: expiresAt(config.oauthAuthorizationCodeTtlSeconds),
    created_at: createdAt
  });
  return code;
}

function pkceMatches(verifier, challenge) {
  const value = String(verifier || "");
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(value)) return false;
  return createHash("sha256").update(value).digest("base64url") === challenge;
}

function issueTokenPair({ clientId, subject, resource, scope, quotaClientId, familyId = opaque("grant") }) {
  const accessToken = opaque("access");
  const refreshToken = opaque("refresh");
  const refreshTokenHash = hash(refreshToken);
  const createdAt = now();
  const accessExpiresAt = expiresAt(config.oauthAccessTokenTtlSeconds);
  const refreshExpiresAt = expiresAt(config.oauthRefreshTokenTtlSeconds);
  sql.createAccess.run({
    token_hash: hash(accessToken), client_id: clientId, subject, resource, scope,
    quota_client_id: quotaClientId, expires_at: accessExpiresAt, created_at: createdAt
  });
  sql.createRefresh.run({
    token_hash: refreshTokenHash, client_id: clientId, subject, resource, scope,
    quota_client_id: quotaClientId, expires_at: refreshExpiresAt, created_at: createdAt
  });
  sql.extendRefreshFamily.run({ family_id: familyId, family_expires_at: refreshExpiresAt });
  sql.createRefreshLineage.run({
    token_hash: refreshTokenHash,
    family_id: familyId,
    family_expires_at: refreshExpiresAt,
    created_at: createdAt
  });
  return {
    familyId,
    refreshTokenHash,
    tokens: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: config.oauthAccessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope
    }
  };
}

export function exchangeAuthorizationCode({ code, clientId, redirectUri, codeVerifier, resource }) {
  return db.transaction(() => {
    const codeHash = hash(code);
    const record = sql.getCode.get(codeHash);
    const timestamp = now();
    if (!record || record.used_at || Date.parse(record.expires_at) <= Date.now()) throw oauthError("invalid_grant", "Authorization code đã hết hạn hoặc đã được sử dụng.");
    if (record.client_id !== String(clientId || "") || record.redirect_uri !== normalizedRedirectUri(redirectUri)) throw oauthError("invalid_grant", "Authorization code không thuộc client/redirect này.");
    if (record.resource !== String(resource || "") || record.resource !== mcpResourceUri()) throw oauthError("invalid_target", "resource không khớp authorization code.");
    if (!pkceMatches(codeVerifier, record.code_challenge)) throw oauthError("invalid_grant", "PKCE verifier không hợp lệ.");
    if (sql.consumeCode.run(timestamp, codeHash, timestamp).changes !== 1) throw oauthError("invalid_grant", "Authorization code đã được sử dụng.");
    return issueTokenPair({
      clientId: record.client_id,
      subject: record.subject,
      resource: record.resource,
      scope: record.scope,
      quotaClientId: record.subject
    }).tokens;
  })();
}

export function exchangeRefreshToken({ refreshToken, clientId, resource }) {
  const outcome = db.transaction(() => {
    const tokenHash = hash(refreshToken);
    const record = sql.getRefresh.get(tokenHash);
    const timestamp = now();
    const currentTime = Date.now();
    let lineage = record ? sql.getRefreshLineage.get(tokenHash) : null;

    if (!record) {
      return { error: oauthError("invalid_grant", "Refresh token đã hết hạn hoặc không hợp lệ.") };
    }
    if (Date.parse(record.expires_at) <= currentTime) {
      if (lineage?.replaced_by_hash && Date.parse(lineage.family_expires_at) > currentTime) {
        sql.revokeRefreshFamily.run({ revoked_at: timestamp, family_id: lineage.family_id });
        return { error: oauthError("invalid_grant", "Phát hiện replay refresh token đã hết hạn; toàn bộ token family đã bị thu hồi.") };
      }
      return { error: oauthError("invalid_grant", "Refresh token đã hết hạn hoặc không hợp lệ.") };
    }
    if (record.client_id !== String(clientId || "")) {
      return { error: oauthError("invalid_client", "Refresh token không thuộc client này.") };
    }
    if (record.resource !== String(resource || "") || record.resource !== mcpResourceUri()) {
      return { error: oauthError("invalid_target", "resource không khớp refresh token.") };
    }

    if (!lineage) {
      const familyId = opaque("grant");
      sql.createRefreshLineage.run({
        token_hash: tokenHash,
        family_id: familyId,
        family_expires_at: record.expires_at,
        created_at: record.created_at || timestamp
      });
      lineage = sql.getRefreshLineage.get(tokenHash);
    }

    if (record.revoked_at) {
      if (lineage?.replaced_by_hash) {
        sql.revokeRefreshFamily.run({ revoked_at: timestamp, family_id: lineage.family_id });
      }
      return { error: oauthError("invalid_grant", "Phát hiện refresh token đã được sử dụng; toàn bộ token family đã bị thu hồi.") };
    }

    const issued = issueTokenPair({
      clientId: record.client_id,
      subject: record.subject,
      resource: record.resource,
      scope: record.scope,
      quotaClientId: record.quota_client_id,
      familyId: lineage.family_id
    });
    if (sql.revokeRefresh.run(timestamp, tokenHash, timestamp).changes !== 1) {
      sql.revokeRefreshFamily.run({ revoked_at: timestamp, family_id: lineage.family_id });
      return { error: oauthError("invalid_grant", "Refresh token đã được sử dụng; toàn bộ token family đã bị thu hồi.") };
    }
    if (sql.linkRefreshReplacement.run(issued.refreshTokenHash, tokenHash).changes !== 1) {
      sql.revokeRefreshFamily.run({ revoked_at: timestamp, family_id: lineage.family_id });
      return { error: oauthError("invalid_grant", "Không thể hoàn tất refresh-token rotation; token family đã bị thu hồi.") };
    }
    return { tokens: issued.tokens };
  })();

  if (outcome.error) throw outcome.error;
  return outcome.tokens;
}

export function getOAuthAccessToken(accessToken) {
  if (!accessToken) return null;
  const row = sql.getAccess.get(hash(accessToken), now());
  if (!row || row.resource !== mcpResourceUri() || !String(row.scope).split(/\s+/u).includes("mcp")) return null;
  return row;
}

export function purgeOAuthState() {
  const timestamp = now();
  sql.purgeLoginStates.run(timestamp);
  sql.purgeConsent.run(timestamp);
  sql.purgeCodes.run(timestamp);
  sql.purgeAccess.run(timestamp);
  sql.purgeRefresh.run({ timestamp });
  sql.purgeRefreshLineage.run();
}

purgeOAuthState();
setInterval(purgeOAuthState, 15 * 60_000).unref();
