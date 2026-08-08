import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lana-oauth-test-"));
process.env.NODE_ENV = "test";
process.env.PUBLIC_BASE_URL = "https://content.example";
process.env.DATABASE_PATH = path.join(root, "lana.sqlite");
process.env.ASSET_DIRECTORY = path.join(root, "assets");
process.env.API_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.OAUTH_ALLOWED_EMAILS = "owner@example.com";
await fs.mkdir(process.env.ASSET_DIRECTORY, { recursive: true });

const {
  consumeConsentRequest,
  createConsentRequest,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getOAuthAccessToken,
  issueAuthorizationCode,
  mcpResourceUri,
  purgeOAuthState,
  registerOAuthClient,
  validateAuthorizationRequest
} = await import("./oauth-store.js");
const oauthRoutes = await import("./oauth-routes.js");
const {
  assertAllowedGoogleIdentity,
  consentHtml,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  setOAuthHtmlSecurityHeaders
} = oauthRoutes;
const { apiSecurity } = await import("./api-security.js");
const { db } = await import("./db.js");

function fakeResponse() {
  return {
    statusCode: 200, headers: {}, body: null, ended: false,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; }
  };
}

function runSecurity(headers = {}) {
  const req = {
    method: "POST", url: "/mcp", originalUrl: "/mcp", headers,
    ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" }
  };
  const res = fakeResponse();
  let nextCalled = false;
  apiSecurity(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function totalDbChanges() {
  return Number(db.prepare("SELECT total_changes() AS changes").get().changes || 0);
}

test("OAuth metadata advertises MCP resource, DCR, PKCE and refresh tokens", () => {
  const resource = oauthProtectedResourceMetadata();
  const server = oauthAuthorizationServerMetadata();
  assert.equal(resource.resource, "https://content.example/mcp");
  assert.deepEqual(resource.authorization_servers, ["https://content.example"]);
  assert.deepEqual(resource.scopes_supported, ["mcp"]);
  assert.equal(server.registration_endpoint, "https://content.example/oauth/register");
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.ok(server.grant_types_supported.includes("refresh_token"));
});

test("authorization code flow is audience-bound, one-time and PKCE protected", () => {
  const client = registerOAuthClient({
    client_name: "ChatGPT MCP",
    redirect_uris: ["https://chatgpt.example/oauth/callback"]
  });
  const verifier = "a".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = validateAuthorizationRequest({
    client_id: client.client_id,
    redirect_uri: "https://chatgpt.example/oauth/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResourceUri(),
    scope: "mcp",
    state: "client-state"
  });
  const consentToken = createConsentRequest(request, "user:test-subject");
  const consent = consumeConsentRequest(consentToken, "user:test-subject");
  const code = issueAuthorizationCode(consent);
  const tokens = exchangeAuthorizationCode({
    code,
    clientId: client.client_id,
    redirectUri: "https://chatgpt.example/oauth/callback",
    codeVerifier: verifier,
    resource: mcpResourceUri()
  });
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.refresh_token);
  assert.equal(getOAuthAccessToken(tokens.access_token).subject, "user:test-subject");
  assert.throws(() => exchangeAuthorizationCode({
    code,
    clientId: client.client_id,
    redirectUri: "https://chatgpt.example/oauth/callback",
    codeVerifier: verifier,
    resource: mcpResourceUri()
  }), error => error.code === "invalid_grant");

  const refreshed = exchangeRefreshToken({
    refreshToken: tokens.refresh_token,
    clientId: client.client_id,
    resource: mcpResourceUri()
  });
  assert.ok(getOAuthAccessToken(refreshed.access_token));

  assert.throws(() => exchangeRefreshToken({
    refreshToken: tokens.refresh_token,
    clientId: client.client_id,
    resource: mcpResourceUri()
  }), error => error.code === "invalid_grant");

  assert.throws(() => exchangeRefreshToken({
    refreshToken: refreshed.refresh_token,
    clientId: client.client_id,
    resource: mcpResourceUri()
  }), error => error.code === "invalid_grant");
});

test("expired refresh ancestor replay revokes a still-active descendant", () => {
  const client = registerOAuthClient({ redirect_uris: ["https://refresh.example/callback"] });
  const verifier = "c".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = validateAuthorizationRequest({
    client_id: client.client_id,
    redirect_uri: "https://refresh.example/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResourceUri(),
    scope: "mcp"
  });
  const consent = consumeConsentRequest(createConsentRequest(request, "user:refresh-expiry"), "user:refresh-expiry");
  const first = exchangeAuthorizationCode({
    code: issueAuthorizationCode(consent),
    clientId: client.client_id,
    redirectUri: "https://refresh.example/callback",
    codeVerifier: verifier,
    resource: mcpResourceUri()
  });
  const second = exchangeRefreshToken({
    refreshToken: first.refresh_token,
    clientId: client.client_id,
    resource: mcpResourceUri()
  });

  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  db.prepare("UPDATE oauth_refresh_tokens SET expires_at=? WHERE token_hash=?").run(past, tokenHash(first.refresh_token));
  db.prepare("UPDATE oauth_refresh_tokens SET expires_at=? WHERE token_hash=?").run(future, tokenHash(second.refresh_token));
  purgeOAuthState();

  assert.throws(() => exchangeRefreshToken({
    refreshToken: first.refresh_token,
    clientId: client.client_id,
    resource: mcpResourceUri()
  }), error => error.code === "invalid_grant");
  assert.throws(() => exchangeRefreshToken({
    refreshToken: second.refresh_token,
    clientId: client.client_id,
    resource: mcpResourceUri()
  }), error => error.code === "invalid_grant");
});

test("refresh rotation keeps fixed family expiry and constant per-request DB writes", () => {
  const client = registerOAuthClient({ redirect_uris: ["https://bounded-refresh.example/callback"] });
  const verifier = "d".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = validateAuthorizationRequest({
    client_id: client.client_id,
    redirect_uri: "https://bounded-refresh.example/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResourceUri(),
    scope: "mcp"
  });
  const consent = consumeConsentRequest(createConsentRequest(request, "user:bounded-refresh"), "user:bounded-refresh");
  const first = exchangeAuthorizationCode({
    code: issueAuthorizationCode(consent),
    clientId: client.client_id,
    redirectUri: "https://bounded-refresh.example/callback",
    codeVerifier: verifier,
    resource: mcpResourceUri()
  });
  const firstLineage = db.prepare("SELECT family_id FROM oauth_refresh_token_lineage WHERE token_hash=?").get(tokenHash(first.refresh_token));
  assert.ok(firstLineage?.family_id);

  const fixedFamilyExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
  let currentRefresh = first.refresh_token;
  const writeDeltas = [];
  for (let index = 0; index < 5; index += 1) {
    db.prepare("UPDATE oauth_refresh_token_lineage SET family_expires_at=? WHERE family_id=?").run(fixedFamilyExpiry, firstLineage.family_id);
    const before = totalDbChanges();
    const next = exchangeRefreshToken({
      refreshToken: currentRefresh,
      clientId: client.client_id,
      resource: mcpResourceUri()
    });
    writeDeltas.push(totalDbChanges() - before);
    currentRefresh = next.refresh_token;
  }

  assert.equal(new Set(writeDeltas).size, 1, `expected constant write work, got ${writeDeltas.join(",")}`);
  const lineageState = db.prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT family_expires_at) AS expiries FROM oauth_refresh_token_lineage WHERE family_id=?").get(firstLineage.family_id);
  assert.equal(Number(lineageState.count), 6);
  assert.equal(Number(lineageState.expiries), 1);
  const currentRow = db.prepare("SELECT expires_at FROM oauth_refresh_tokens WHERE token_hash=?").get(tokenHash(currentRefresh));
  assert.equal(currentRow.expires_at, fixedFamilyExpiry);
});

test("OAuth token endpoint limiter bounds requests per client without coupling clients behind one proxy", () => {
  const consume = oauthRoutes.consumeOAuthTokenRateLimit;
  assert.equal(typeof consume, "function");
  let denied = null;
  for (let index = 0; index < 200; index += 1) {
    const outcome = consume("client-a", 120_000);
    if (!outcome.allowed) {
      denied = outcome;
      break;
    }
  }
  assert.ok(denied, "token limiter should reject a client burst before 200 requests");
  assert.ok(Number(denied.retryAfterSeconds) >= 1 && Number(denied.retryAfterSeconds) <= 60);
  assert.equal(consume("client-b", 120_000).allowed, true);
  assert.equal(consume("client-a", 180_001).allowed, true);
});

test("open DCR consent visibly distinguishes a self-asserted trusted name from its callback", () => {
  const html = consentHtml({
    clientName: "ChatGPT",
    scope: "mcp",
    consentToken: "consent-test",
    redirectUri: "https://evil.example/oauth/callback"
  });
  assert.match(html, />ChatGPT</u);
  assert.match(html, /chưa được Lana xác minh/u);
  assert.match(html, /Callback host:/u);
  assert.match(html, /evil\.example/u);
  assert.match(html, /https:\/\/evil\.example\/oauth\/callback/u);
});

test("OAuth authorization HTML blocks framing", () => {
  const res = fakeResponse();
  setOAuthHtmlSecurityHeaders(res);
  assert.equal(res.headers["content-security-policy"], "frame-ancestors 'none'");
  assert.equal(res.headers["x-frame-options"], "DENY");
});

test("MCP accepts OAuth Bearer and rejects legacy API key authentication", () => {
  const client = registerOAuthClient({ redirect_uris: ["https://client.example/callback"] });
  const verifier = "b".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = validateAuthorizationRequest({
    client_id: client.client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResourceUri()
  });
  const consent = consumeConsentRequest(createConsentRequest(request, "user:mcp"), "user:mcp");
  const tokens = exchangeAuthorizationCode({
    code: issueAuthorizationCode(consent),
    clientId: client.client_id,
    redirectUri: "https://client.example/callback",
    codeVerifier: verifier,
    resource: mcpResourceUri()
  });

  const oauth = runSecurity({ authorization: `Bearer ${tokens.access_token}` });
  assert.equal(oauth.nextCalled, true);
  assert.equal(oauth.req.apiAccessType, "oauth-token");
  assert.equal(oauth.req.apiClientId, "user:mcp");

  const legacy = runSecurity({ "x-api-key": process.env.API_KEY });
  assert.equal(legacy.nextCalled, false);
  assert.equal(legacy.res.statusCode, 401);
  assert.match(String(legacy.res.headers["www-authenticate"]), /resource_metadata=/u);

  const missing = runSecurity();
  assert.equal(missing.res.statusCode, 401);
  assert.match(String(missing.res.headers["www-authenticate"]), /scope="mcp"/u);
});

test("Google identity must be verified and present on the configured allowlist", () => {
  const allowed = assertAllowedGoogleIdentity({
    sub: "google-123",
    email: "OWNER@example.com",
    email_verified: true,
    name: "Owner"
  });
  assert.equal(allowed.email, "owner@example.com");
  assert.throws(() => assertAllowedGoogleIdentity({
    sub: "google-456", email: "other@example.com", email_verified: true
  }), error => error.code === "GOOGLE_ACCOUNT_NOT_ALLOWED");
});

test("admin login UI contains Google OAuth and no API-key input or submission", async () => {
  const rootUrl = new URL("../", import.meta.url);
  const [html, script] = await Promise.all([
    fs.readFile(new URL("public/admin-auth.html", rootUrl), "utf8"),
    fs.readFile(new URL("public/admin-auth.js", rootUrl), "utf8")
  ]);
  assert.match(html, /Tiếp tục với Google/u);
  assert.match(script, /\/auth\/google\/start/u);
  assert.equal(/id="apiKey"|name="apiKey"|type="password"/u.test(html), false);
  assert.equal(/X-API-Key|keyInput|\/auth\/admin-session[^\n]*method/u.test(script), false);
});
