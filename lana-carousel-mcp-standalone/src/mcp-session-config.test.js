import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.MCP_MAX_SESSIONS_PER_PRINCIPAL = "200";
process.env.MCP_SESSION_TTL_SECONDS = "1800";

const { config } = await import("./config.js");
const { McpPrincipalBindings } = await import("./mcp-principal-binding.js");

test("MCP session capacity and TTL are read from environment", () => {
  assert.equal(config.mcpMaxSessionsPerPrincipal, 200);
  assert.equal(config.mcpSessionTtlSeconds, 1800);

  const registry = new McpPrincipalBindings();
  assert.equal(registry.maxSessionsPerPrincipal, 200);
  assert.equal(registry.ttlMs, 1_800_000);
});
