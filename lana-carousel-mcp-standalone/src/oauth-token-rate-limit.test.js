import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lana-oauth-rate-limit-test-"));
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
  issueAuthorizationCode,
  mcpResourceUri,
  registerOAuthClient,
  validateAuthorizationRequest
} = await import("./oauth-store.js");
const { consumeOAuthTokenPreAuthRateLimit, registerOAuthRoutes } = await import("./oauth-routes.js");

function formBody(values) {
  return new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
}

async function postToken(baseUrl, values, headers = {}) {
  return fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: formBody(values)
  });
}

function createValidAuthorizationCode({ redirectUri, subject }) {
  const client = registerOAuthClient({ redirect_uris: [redirectUri] });
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const request = validateAuthorizationRequest({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResourceUri(),
    scope: "mcp"
  });
  const consent = consumeConsentRequest(createConsentRequest(request, subject), subject);
  return { client, verifier, code: issueAuthorizationCode(consent) };
}

test("invalid requests carrying a registered client id cannot starve its valid token exchange", async t => {
  const app = express();
  registerOAuthRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const redirectUri = "https://targeted-limit.example/callback";
  const { client, verifier, code: validCode } = createValidAuthorizationCode({ redirectUri, subject: "user:targeted-limit" });

  for (let index = 0; index < 60; index += 1) {
    const bogus = await postToken(baseUrl, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: `bogus-${index}`,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: mcpResourceUri()
    });
    assert.equal(bogus.status, 400);
  }

  const valid = await postToken(baseUrl, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: validCode,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: mcpResourceUri()
  });
  assert.equal(valid.status, 200, "bogus requests that only know client_id must not exhaust the proven-client bucket");
  const payload = await valid.json();
  assert.equal(payload.token_type, "Bearer");
  assert.ok(payload.access_token);
  assert.ok(payload.refresh_token);
});

test("one forwarded attacker behind a trusted proxy cannot exhaust preauth capacity for another client", async t => {
  const app = express();
  app.set("trust proxy", ["loopback"]);
  registerOAuthRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Saturate exactly the bucket that the current implementation incorrectly derives
  // from req.socket.remoteAddress for every request coming through this proxy peer.
  while (consumeOAuthTokenPreAuthRateLimit("127.0.0.1").allowed) {
    // keep consuming until the proxy-wide bucket is full
  }

  const redirectUri = "https://proxy-isolation.example/callback";
  const { client, verifier, code } = createValidAuthorizationCode({ redirectUri, subject: "user:proxy-victim" });
  const valid = await postToken(baseUrl, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: mcpResourceUri()
  }, { "x-forwarded-for": "198.51.100.77" });

  assert.equal(valid.status, 200, "trusted proxy client IP must isolate the victim from another source's exhausted preauth bucket");
});
