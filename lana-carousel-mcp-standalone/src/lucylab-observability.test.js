import assert from "node:assert/strict";
import test from "node:test";
import { lucylabJsonRpc } from "./lucylab-client.js";

const serializedLogs = logs => JSON.stringify(logs);

async function captureErrors(run) {
 const originalError = console.error;
 const logs = [];
 console.error = (...args) => logs.push(args);
 try {
  await run();
 } finally {
  console.error = originalError;
 }
 return logs;
}

test("logs safe Lucylab HTTP failure diagnostics without secrets or provider bodies", async () => {
 const originalFetch = globalThis.fetch;
 const apiKey = "test-super-secret-lucylab-key";
 const cases = [
  { status: 401, group: "auth" },
  { status: 429, group: "rate_limit" },
  { status: 503, group: "upstream" }
 ];
 try {
  for (const { status, group } of cases) {
   globalThis.fetch = async () => ({
    ok: false,
    status,
    json: async () => ({ error: { message: "provider-secret-response-body" } })
   });
   const logs = await captureErrors(async () => {
    await assert.rejects(
     lucylabJsonRpc({ apiKey, method: "ttsLongText", input: { text: "private input" } }),
     error => error?.code === "TTS_PROVIDER_FAILED"
    );
   });
   assert.equal(logs.length, 1);
   const output = serializedLogs(logs);
   assert.match(output, /lucylab_json_rpc_failed/u);
   assert.match(output, /ttsLongText/u);
   assert.match(output, new RegExp(`\\"status\\":${status}`, "u"));
   assert.match(output, new RegExp(`\\"group\\":\\"${group}\\"`, "u"));
   assert.doesNotMatch(output, /test-super-secret-lucylab-key|provider-secret-response-body|private input/u);
  }
 } finally {
  globalThis.fetch = originalFetch;
 }
});

test("logs timeout as a safe Lucylab diagnostic group", async () => {
 const originalFetch = globalThis.fetch;
 const apiKey = "timeout-secret-key";
 globalThis.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
  const keepAlive = setTimeout(() => resolve({ ok: true, json: async () => ({ result: {} }) }), 1000);
  options.signal.addEventListener("abort", () => {
   clearTimeout(keepAlive);
   reject(options.signal.reason);
  }, { once: true });
 });
 try {
  const logs = await captureErrors(async () => {
   await assert.rejects(
    lucylabJsonRpc({ apiKey, method: "getExportStatus", input: { projectExportId: "private-export-id" }, timeoutMs: 20 }),
    error => error?.code === "TTS_PROVIDER_FAILED"
   );
  });
  assert.equal(logs.length, 1);
  const output = serializedLogs(logs);
  assert.match(output, /lucylab_json_rpc_failed/u);
  assert.match(output, /getExportStatus/u);
  assert.match(output, /\"group\":\"timeout\"/u);
  assert.doesNotMatch(output, /timeout-secret-key|private-export-id/u);
 } finally {
  globalThis.fetch = originalFetch;
 }
});
