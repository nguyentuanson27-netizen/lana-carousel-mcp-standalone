import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenAIAdsEvent, sha256NormalizedEmail } from "./openai-ads.js";

test("sha256NormalizedEmail normalizes case and whitespace", () => {
  assert.equal(
    sha256NormalizedEmail("  USER@Example.COM "),
    "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514"
  );
});

test("buildOpenAIAdsEvent creates a purchase payload and hashes raw email", () => {
  const now = 1_800_000_000_000;
  const event = buildOpenAIAdsEvent({
    id: "order_123",
    type: "order_created",
    timestamp_ms: now,
    source_url: "https://www.lanadesign.vn/checkout/success",
    oppref: "example_oppref",
    user: {
      obref: "browser_ref",
      email: "USER@example.com",
      country: "vn",
      city: "Ha Noi"
    },
    data: {
      type: "contents",
      amount: 1599000,
      currency: "VND",
      contents: [{ id: "sku_1", content_type: "product", quantity: 1 }]
    }
  }, { now });

  assert.equal(event.action_source, "web");
  assert.equal(event.user.country, "VN");
  assert.equal(event.user.city, "ha noi");
  assert.equal(event.user.email_sha256, sha256NormalizedEmail("user@example.com"));
  assert.equal(event.data.amount, 1599000);
});

test("buildOpenAIAdsEvent rejects a mismatched data shape", () => {
  assert.throws(
    () => buildOpenAIAdsEvent({
      id: "lead_1",
      type: "lead_created",
      source_url: "https://www.lanadesign.vn/contact",
      data: { type: "contents" }
    }),
    /data\.type=customer_action/
  );
});

test("buildOpenAIAdsEvent requires currency when amount is present", () => {
  assert.throws(
    () => buildOpenAIAdsEvent({
      id: "order_2",
      type: "order_created",
      source_url: "https://www.lanadesign.vn/checkout/success",
      data: { type: "contents", amount: 1000 }
    }),
    /currency/
  );
});
