import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function normalizeQuotaClientId(value, fallback = "mcp:anonymous") {
  const candidate = String(value || "").trim();
  return candidate || fallback;
}

export function runWithQuotaPrincipal(clientId, callback) {
  return storage.run({ clientId: normalizeQuotaClientId(clientId) }, callback);
}

export function currentQuotaClientId(fallback = "mcp:anonymous") {
  return normalizeQuotaClientId(storage.getStore()?.clientId, fallback);
}
