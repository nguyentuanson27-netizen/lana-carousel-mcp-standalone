import { AppError } from "./errors.js";

const LUCYLAB_API_URL = "https://api.lucylab.io/json-rpc";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function unavailable(message = "Lucylab AI tạm thời không đọc được. Vui lòng thử lại.") {
 return new AppError("TTS_PROVIDER_FAILED", message, 502);
}

export async function lucylabJsonRpc({ apiKey, method, input, timeoutMs = DEFAULT_TIMEOUT_MS }) {
 let response;
 try {
  response = await fetch(LUCYLAB_API_URL, {
   method: "POST",
   headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
   },
   body: JSON.stringify({ method, input }),
   signal: AbortSignal.timeout(timeoutMs)
  });
 } catch {
  throw unavailable();
 }

 if (!response.ok) throw unavailable();
 const data = await response.json().catch(() => null);
 if (!data || data.error || !("result" in data)) throw unavailable();
 return data.result;
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
   throw new AppError("TTS_PROVIDER_FAILED", "Lucylab AI tạo audio thất bại. Vui lòng thử lại.", 502);
  }
  if (result?.state === "completed" && result.url) return result.url;
 }

 throw new AppError("TTS_PROVIDER_FAILED", "Lucylab AI tạo audio quá lâu. Vui lòng thử lại.", 504);
}