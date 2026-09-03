import { AppError } from "./errors.js";

const LUCYLAB_API_URL = "https://api.lucylab.io/json-rpc";
const DEFAULT_TIMEOUT_MS = 15_000;

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
