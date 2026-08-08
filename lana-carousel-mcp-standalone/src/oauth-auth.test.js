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
  registerOAuthClient,
  validateAuthorizationRequest
} = await import("./oauth-store.js");
const {
  assertAllowedGoogleIdentity,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata
} = await import("./oauth-routes.js");
const { apiSecurity } = await import("./api-security.js");

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
