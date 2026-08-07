import { AppError } from "./errors.js";
import { normalizeQuotaClientId } from "./quota-principal.js";

const defaultTtlMs = 2 * 60 * 60 * 1000;
const defaultMaxSessionsPerPrincipal = 20;

export class McpPrincipalBindings {
  constructor({
    ttlMs = defaultTtlMs,
    maxSessionsPerPrincipal = defaultMaxSessionsPerPrincipal
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessionsPerPrincipal = maxSessionsPerPrincipal;
    this.sessions = new Map();
    this.pendingByPrincipal = new Map();
    this.closing = Promise.resolve();
  }

  bind(sessionId, principal, resources = {}) {
    if (!sessionId) return null;
    const key = String(sessionId);
    const current = this.sessions.get(key) || {};
    const entry = {
      ...current,
      principal: normalizeQuotaClientId(principal),
      transport: resources.transport ?? current.transport,
      server: resources.server ?? current.server,
      touchedAt: Date.now()
    };
    this.sessions.set(key, entry);
    return entry;
  }

  reserve(principal) {
    const normalized = normalizeQuotaClientId(principal);
    const active = [...this.sessions.values()].filter(entry => entry.principal === normalized).length;
    const pending = this.pendingByPrincipal.get(normalized) || 0;
    if (active + pending >= this.maxSessionsPerPrincipal) {
      throw new AppError(
        "MCP_SESSION_LIMIT_REACHED",
        `Mỗi API principal chỉ được mở tối đa ${this.maxSessionsPerPrincipal} MCP session đồng thời.`,
        429
      );
    }
    this.pendingByPrincipal.set(normalized, pending + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.pendingByPrincipal.get(normalized) || 1) - 1;
      if (next > 0) this.pendingByPrincipal.set(normalized, next);
      else this.pendingByPrincipal.delete(normalized);
    };
  }

  assert(sessionId, principal) {
    if (!sessionId) return true;
    const entry = this.sessions.get(String(sessionId));
    if (!entry) {
      throw new AppError(
        "MCP_SESSION_BINDING_MISSING",
        "MCP session đã hết hạn hoặc không còn principal binding hợp lệ.",
        403
      );
    }
    const current = normalizeQuotaClientId(principal);
    if (entry.principal !== current) {
      throw new AppError(
        "MCP_SESSION_PRINCIPAL_MISMATCH",
        "MCP session không thuộc API principal hiện tại.",
        403
      );
    }
    entry.touchedAt = Date.now();
    return true;
  }

  get(sessionId, principal) {
    this.assert(sessionId, principal);
    return this.sessions.get(String(sessionId));
  }

  detach(sessionId) {
    const key = String(sessionId || "");
    const entry = this.sessions.get(key) || null;
    this.sessions.delete(key);
    return entry;
  }

  delete(sessionId) {
    return Boolean(this.detach(sessionId));
  }

  async closeEntry(entry) {
    if (!entry) return;
    const operations = [];
    if (typeof entry.transport?.close === "function") operations.push(Promise.resolve().then(() => entry.transport.close()));
    if (typeof entry.server?.close === "function") operations.push(Promise.resolve().then(() => entry.server.close()));
    await Promise.allSettled(operations);
  }

  async close(sessionId) {
    const entry = this.detach(sessionId);
    if (!entry) return false;
    await this.closeEntry(entry);
    return true;
  }

  purge(now = Date.now()) {
    const removed = [];
    const entries = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.touchedAt < now - this.ttlMs) {
        this.sessions.delete(sessionId);
        removed.push(sessionId);
        entries.push(entry);
      }
    }
    this.closing = Promise.allSettled(entries.map(entry => this.closeEntry(entry)));
    return removed;
  }

  async waitForClosing() {
    await this.closing;
  }
}

export const mcpPrincipalBindings = new McpPrincipalBindings();

export function enforceMcpPrincipal(req, res, principal) {
  const sessionId = String(req.headers["mcp-session-id"] || "");
  mcpPrincipalBindings.assert(sessionId, principal);
  if (sessionId || typeof res.once !== "function") return;

  res.once("finish", () => {
    if (res.statusCode >= 400 || typeof res.getHeader !== "function") return;
    const createdSessionId = String(res.getHeader("mcp-session-id") || "");
    if (createdSessionId) mcpPrincipalBindings.bind(createdSessionId, principal);
  });
}

setInterval(() => {
  mcpPrincipalBindings.purge();
  mcpPrincipalBindings.waitForClosing().catch(() => undefined);
}, 15 * 60_000).unref();
