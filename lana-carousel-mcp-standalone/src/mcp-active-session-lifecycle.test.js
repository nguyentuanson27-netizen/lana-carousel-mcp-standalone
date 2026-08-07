import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  McpPrincipalBindings,
  enforceMcpPrincipal,
  mcpPrincipalBindings
} from "./mcp-principal-binding.js";

test("active MCP activity is not purged until every request releases", () => {
  const registry = new McpPrincipalBindings({ ttlMs: 10, maxSessionsPerPrincipal: 2 });
  registry.bind("stream", "key:a");

  const first = registry.beginActivity("stream", "key:a");
  const second = registry.beginActivity("stream", "key:a");
  const active = registry.sessions.get("stream");
  assert.equal(active.activeRequests, 2);
  assert.deepEqual(registry.purge(active.touchedAt + 1000), []);

  first.release();
  assert.equal(registry.sessions.get("stream").activeRequests, 1);
  assert.deepEqual(registry.purge(Date.now() + 1000), []);

  second.release();
  const released = registry.sessions.get("stream");
  assert.equal(released.activeRequests, 0);
  assert.deepEqual(registry.purge(released.touchedAt + 11), ["stream"]);
});

test("enforceMcpPrincipal keeps an open response active through the response lifecycle", () => {
  const principal = `review:${Date.now()}`;
  const sessionId = `session:${Date.now()}`;
  const res = new EventEmitter();

  mcpPrincipalBindings.bind(sessionId, principal);
  enforceMcpPrincipal({ headers: { "mcp-session-id": sessionId } }, res, principal);

  const active = mcpPrincipalBindings.sessions.get(sessionId);
  assert.equal(active.activeRequests, 1);
  assert.deepEqual(
    mcpPrincipalBindings.purge(active.touchedAt + mcpPrincipalBindings.ttlMs + 1),
    []
  );

  res.emit("finish");
  const released = mcpPrincipalBindings.sessions.get(sessionId);
  assert.equal(released.activeRequests, 0);
  assert.deepEqual(
    mcpPrincipalBindings.purge(released.touchedAt + mcpPrincipalBindings.ttlMs + 1),
    [sessionId]
  );
});
