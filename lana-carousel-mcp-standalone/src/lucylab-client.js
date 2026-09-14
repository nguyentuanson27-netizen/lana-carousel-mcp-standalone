import { config } from "./config.js";
import { AppError } from "./errors.js";

const LUCYLAB_API_URL = "https://api.lucylab.io/json-rpc";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXPORT_TIMEOUT_MS = Math.max(
 10_000,
 Number.parseInt(process.env.LUCYLAB_EXPORT_TIMEOUT_MS || "", 10) || 120_000
);
const DEFAULT_POLL_INTERVAL_MS = Math.max(
 1_000,
 Number.parseInt(process.env.LUCYLAB_POLL_INTERVAL_MS || "", 10) || 4_000
);
const DOCUMENTED_METHODS = new Set(["ttsLongText", "getExportStatus"]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function unavailable(message = "Lucylab AI tạm thời không đọc được. Vui lòng thử lại.") {
 return new AppError("TTS_PROVIDER_FAILED", message, 502);
}

function safeMethod(method) {
 return DOCUMENTED_METHODS.has(method) ? method : "unknown";
}

function httpFailureGroup(status) {
 if (status === 401 || status === 403) return "auth";
 if (status === 429) return "rate_limit";
 if (status >= 500) return "upstream";
 return "http";
}

function logRpcFailure({ method, status = 0, group }) {
 // Provider responses and request inputs can contain customer text or secrets. Keep this event
 // deliberately low-cardinality and metadata-only so production failures are diagnosable without
 // copying the API key, request body, response body or raw thrown error into logs.
 console.error("lucylab_json_rpc_failed", {
  method: safeMethod(method),
  status: Number.isInteger(status) ? status : 0,
  group
 });
}

function logExportFailure(group) {
 // Export ids identify provider-side work and are unnecessary for triage here. The state category
 // is enough to distinguish an explicit provider failure from a workflow that exhausted its SLA.
 console.error("lucylab_export_failed", { group });
}

export async function lucylabJsonRpc({ apiKey, method, input, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = 3 }) {
 for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
   response = await fetch(LUCYLAB_API_URL, {
    method: "POST",
    headers: {
     "Authorization": `Bearer ${apiKey}`,
     "Content-Type": "application/json"
    },
    body: JSON.stringify({ method, input }),
    signal
   });
  } catch {
   logRpcFailure({ method, group: signal.aborted ? "timeout" : "network" });
   throw unavailable();
  }

  if (!response.ok) {
   logRpcFailure({ method, status: response.status, group: httpFailureGroup(response.status) });
   throw unavailable();
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
   logRpcFailure({ method, status: response.status, group: "protocol" });
   throw unavailable();
  }
  if (data.error) {
   const msg = String(data.error?.message || "");
   if (attempt < maxRetries && msg.includes("already have an export in progress")) {
    await sleep(DEFAULT_POLL_INTERVAL_MS);
    continue;
   }
   logRpcFailure({ method, status: response.status, group: "rpc" });
   throw unavailable();
  }
  if (!("result" in data)) {
   logRpcFailure({ method, status: response.status, group: "protocol" });
   throw unavailable();
  }
  return data.result;
 }
}

// `getUserInfo` is a legacy Lucylab method that is not part of the current public API docs. The
// Studio uses it only for a rough operator-facing estimate, so keep the response intentionally
// coarse and discard every account field except the rounded remaining-credit number.
export async function getLucylabCredits({ apiKey } = {}) {
 const key = String(apiKey || process.env.LUCYLAB_API_KEY || config.lucylabApiKey || "").trim();
 if (!key) {
  throw new AppError("TTS_NOT_CONFIGURED", "Máy chủ chưa cấu hình Lucylab API Key (thiếu LUCYLAB_API_KEY).", 503);
 }
 const result = await lucylabJsonRpc({ apiKey: key, method: "getUserInfo", input: {} });
 const raw = Number(result?.user?.creditsRemaining);
 if (!Number.isFinite(raw) || raw < 0) {
  throw unavailable("Chưa lấy được credit Lucylab. Vui lòng thử lại.");
 }
 return {
  creditsRemaining: Math.max(0, Math.round(raw / 100) * 100),
  estimated: true
 };
}

export async function waitForLucylabExport({
 apiKey,
 projectExportId,
 totalTimeoutMs = DEFAULT_EXPORT_TIMEOUT_MS,
 pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
 now = Date.now,
 delay = sleep,
 requestStatus
}) {
 const deadline = now() + totalTimeoutMs;
 const fetchStatus = requestStatus || (timeoutMs => lucylabJsonRpc({
  apiKey,
  method: "getExportStatus",
  input: { projectExportId },
  timeoutMs
 }));

 for (let attempt = 0; ; attempt += 1) {
  const remainingBeforeWait = deadline - now();
  if (remainingBeforeWait <= 0) break;
  if (attempt > 0) {
   await delay(Math.min(pollIntervalMs, remainingBeforeWait));
   if (deadline - now() <= 0) break;
  }

  const remaining = deadline - now();
  const requestTimeoutMs = Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, remaining));
  let result;
  try {
   result = await fetchStatus(requestTimeoutMs);
  } catch (error) {
   if (deadline - now() <= 0) break;
   throw error;
  }
  if (result?.state === "failed") {
   logExportFailure("provider_state");
   throw new AppError("TTS_PROVIDER_FAILED", "Lucylab AI tạo audio thất bại. Vui lòng thử lại.", 502);
  }
  if (result?.state === "completed" && result.url) return result.url;
 }

 logExportFailure("deadline");
 throw new AppError("TTS_PROVIDER_FAILED", "Lucylab AI tạo audio quá lâu. Vui lòng thử lại.", 504);
}
