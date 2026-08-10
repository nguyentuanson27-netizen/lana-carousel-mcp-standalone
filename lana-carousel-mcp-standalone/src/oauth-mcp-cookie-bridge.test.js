import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import express from "express";

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch { chromium = null; }

async function reservePort() {
  const server = http.createServer((_req, res) => res.end("reserved"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "lana-oauth-cookie-bridge-"));
const lanaPort = await reservePort();
process.env.NODE_ENV = "test";
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${lanaPort}`;
process.env.DATABASE_PATH = path.join(tempDirectory, "lana.sqlite");
process.env.ASSET_DIRECTORY = path.join(tempDirectory, "assets");
process.env.API_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.OAUTH_ALLOWED_EMAILS = "owner@example.com";
await fs.mkdir(process.env.ASSET_DIRECTORY, { recursive: true });

const { OAuth2Client } = await import("google-auth-library");
const originalGetToken = OAuth2Client.prototype.getToken;
const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
OAuth2Client.prototype.getToken = async () => ({ tokens: { id_token: "fake-id-token" } });
OAuth2Client.prototype.verifyIdToken = async () => ({
  getPayload: () => ({ sub: "google-mcp-cookie-bridge", email: "owner@example.com", email_verified: true, name: "Owner" })
});

const {
  createGoogleLoginState,
  mcpResourceUri,
  registerOAuthClient
} = await import("./oauth-store.js");
const { registerOAuthRoutes } = await import("./oauth-routes.js");
const { db } = await import("./db.js");

let browser = null;
let lanaServer = null;
let clientServer = null;

after(async () => {
  OAuth2Client.prototype.getToken = originalGetToken;
  OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
  await browser?.close();
  await new Promise(resolve => lanaServer ? lanaServer.close(resolve) : resolve());
  await new Promise(resolve => clientServer ? clientServer.close(resolve) : resolve());
  db.close();
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

test("MCP OAuth Google callback breaks the cross-site redirect chain before re-entering authorize", { skip: chromium ? false : "chưa cài playwright" }, async t => {
  try {
    browser = await chromium.launch();
  } catch (error) {
    t.skip(`không mở được Chromium: ${error.message.split("\n")[0]}`);
    return;
  }

  const app = express();
  registerOAuthRoutes(app);
  lanaServer = app.listen(lanaPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    lanaServer.once("listening", resolve);
    lanaServer.once("error", reject);
  });

  const redirectUri = "https://chatgpt.example/oauth/callback";
  const client = registerOAuthClient({ client_name: "ChatGPT MCP", redirect_uris: [redirectUri] });
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeQuery = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResourceUri(),
    scope: "mcp",
    state: "chatgpt-state"
  });
  const returnTo = `/oauth/authorize?${authorizeQuery}`;
  const loginState = createGoogleLoginState(returnTo);
  const callbackUrl = `${process.env.PUBLIC_BASE_URL}/auth/google/callback?state=${encodeURIComponent(loginState)}&code=fake-google-code`;

  clientServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><a id="connect" href="${callbackUrl}">Continue OAuth</a>`);
  });
  await new Promise(resolve => clientServer.listen(0, "127.0.0.1", resolve));
  const clientAddress = clientServer.address();
  assert.ok(clientAddress && typeof clientAddress === "object");
  const clientOrigin = `http://localhost:${clientAddress.port}`;

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("https://accounts.google.com/**", route => route.abort());
  await page.goto(clientOrigin);

  const outcomePromise = Promise.race([
    page.waitForSelector("text=Kết nối Lana MCP", { timeout: 8_000 }).then(() => "consent"),
    page.waitForRequest(request => request.url().includes("/auth/google/start"), { timeout: 8_000 }).then(() => "login-loop")
  ]);
  await page.click("#connect");
  const outcome = await outcomePromise;

  assert.equal(outcome, "consent", "Strict admin cookie must become usable before MCP re-enters /oauth/authorize");
  const cookies = await context.cookies(process.env.PUBLIC_BASE_URL);
  const sessionCookie = cookies.find(cookie => cookie.name === "lana_admin_session");
  assert.ok(sessionCookie, "Google callback must create the Lana admin session");
  assert.equal(sessionCookie.sameSite, "Strict", "fix must preserve the Strict admin-session policy");
  assert.match(await page.locator("body").innerText(), /Kết nối Lana MCP/u);
  await context.close();
});
