import { createHash } from "node:crypto";
import { config } from "./config.js";
import { AppError } from "./errors.js";

const CAPI_ENDPOINT = "https://bzr.openai.com/v1/events";
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 10 * 60 * 1000;

const EVENT_DATA_TYPES = Object.freeze({
  page_viewed: "contents",
  contents_viewed: "contents",
  items_added: "contents",
  checkout_started: "contents",
  order_created: "contents",
  lead_created: "customer_action",
  registration_completed: "customer_action",
  appointment_scheduled: "customer_action",
  subscription_created: "plan_enrollment",
  trial_started: "plan_enrollment",
  custom: "custom"
});

function nonEmpty(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

export function sha256NormalizedEmail(value) {
  const email = nonEmpty(value)?.toLowerCase();
  if (!email) return undefined;
  return createHash("sha256").update(email).digest("hex");
}

function normalizeUser(user = {}) {
  const normalized = {};

  const obref = nonEmpty(user.obref);
  if (obref) normalized.obref = obref;

  const emailSha256 = nonEmpty(user.email_sha256) || sha256NormalizedEmail(user.email);
  if (emailSha256) normalized.email_sha256 = emailSha256.toLowerCase();

  const externalIdSha256 = nonEmpty(user.external_id_sha256);
  if (externalIdSha256) normalized.external_id_sha256 = externalIdSha256.toLowerCase();

  const country = nonEmpty(user.country);
  if (country) normalized.country = country.toUpperCase();

  const city = nonEmpty(user.city);
  if (city) normalized.city = city.toLowerCase();

  const zipCode = nonEmpty(user.zip_code);
  if (zipCode) normalized.zip_code = zipCode;

  const ipAddress = nonEmpty(user.ip_address);
  if (ipAddress) normalized.ip_address = ipAddress;

  const userAgent = nonEmpty(user.user_agent);
  if (userAgent) normalized.user_agent = userAgent;

  return Object.keys(normalized).length ? normalized : undefined;
}

function validateEventData(event) {
  const expectedDataType = EVENT_DATA_TYPES[event.type];
  if (!expectedDataType) {
    throw new AppError("OPENAI_ADS_UNSUPPORTED_EVENT", "Sự kiện OpenAI Ads không được hỗ trợ.", 400);
  }
  if (event.data?.type !== expectedDataType) {
    throw new AppError(
      "OPENAI_ADS_INVALID_EVENT_DATA",
      `Sự kiện ${event.type} phải dùng data.type=${expectedDataType}.`,
      400
    );
  }

  if (event.type === "custom" && !nonEmpty(event.custom_event_name)) {
    throw new AppError("OPENAI_ADS_CUSTOM_EVENT_NAME_REQUIRED", "custom_event_name là bắt buộc cho sự kiện custom.", 400);
  }

  if (event.data?.amount !== undefined && !nonEmpty(event.data?.currency)) {
    throw new AppError("OPENAI_ADS_CURRENCY_REQUIRED", "currency là bắt buộc khi event có amount.", 400);
  }
}

export function buildOpenAIAdsEvent(input, { now = Date.now() } = {}) {
  const timestampMs = Number.isInteger(input.timestamp_ms) ? input.timestamp_ms : now;
  if (timestampMs < now - MAX_EVENT_AGE_MS || timestampMs > now + MAX_EVENT_FUTURE_SKEW_MS) {
    throw new AppError(
      "OPENAI_ADS_INVALID_TIMESTAMP",
      "timestamp_ms phải nằm trong 7 ngày gần nhất và không được vượt quá 10 phút trong tương lai.",
      400
    );
  }

  const event = {
    id: nonEmpty(input.id),
    type: nonEmpty(input.type),
    timestamp_ms: timestampMs,
    source_url: nonEmpty(input.source_url),
    action_source: "web",
    data: input.data
  };

  if (!event.id || !event.type || !event.source_url) {
    throw new AppError("OPENAI_ADS_INVALID_EVENT", "OpenAI Ads event thiếu id, type hoặc source_url.", 400);
  }

  const customEventName = nonEmpty(input.custom_event_name);
  if (customEventName) event.custom_event_name = customEventName;

  const oppref = nonEmpty(input.oppref);
  if (oppref) event.oppref = oppref;

  const user = normalizeUser(input.user);
  if (user) event.user = user;

  if (input.opt_out === true) event.opt_out = true;

  validateEventData(event);
  return event;
}

export async function sendOpenAIAdsEvents(inputs, { validateOnly = false, fetchImpl = fetch } = {}) {
  if (!config.openAiAdsPixelId || !config.openAiConversionsApiKey) {
    throw new AppError(
      "OPENAI_ADS_NOT_CONFIGURED",
      "OpenAI Ads conversion tracking chưa được cấu hình trên server.",
      503
    );
  }

  const events = inputs.map(input => buildOpenAIAdsEvent(input));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openAiAdsRequestTimeoutMs);

  try {
    const response = await fetchImpl(
      `${CAPI_ENDPOINT}?pid=${encodeURIComponent(config.openAiAdsPixelId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openAiConversionsApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          validate_only: Boolean(validateOnly),
          integration_source: "lana_design",
          events
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new AppError(
        "OPENAI_ADS_CAPI_REJECTED",
        "OpenAI Ads từ chối conversion event. Hãy kiểm tra Pixel ID, CAPI key và payload.",
        502
      );
    }

    return {
      ok: true,
      accepted: events.length,
      validateOnly: Boolean(validateOnly)
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === "AbortError") {
      throw new AppError("OPENAI_ADS_CAPI_TIMEOUT", "OpenAI Ads CAPI phản hồi quá chậm.", 504);
    }
    throw new AppError("OPENAI_ADS_CAPI_UNAVAILABLE", "Không gửi được conversion event tới OpenAI Ads.", 502);
  } finally {
    clearTimeout(timer);
  }
}
