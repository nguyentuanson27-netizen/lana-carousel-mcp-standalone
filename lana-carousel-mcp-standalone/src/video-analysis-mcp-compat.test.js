import assert from "node:assert/strict";
import test from "node:test";
import {briefFromArgs} from "./video-analysis-mcp-compat.js";

test("stale-schema draft is allowed only when every brief field is omitted", () => {
  assert.equal(briefFromArgs({title: "Demo"}), null);

  for (const args of [
    {content_goal: "sales"},
    {custom_content_domain: "fashion accessories"},
    {custom_content_goal: "launch campaign"}
  ]) {
    assert.throws(
      () => briefFromArgs(args),
      error => error.code === "VIDEO_ANALYSIS_BRIEF_INCOMPLETE"
    );
  }
});

test("complete brief preserves required and optional values", () => {
  assert.deepEqual(
    briefFromArgs({
      content_domain: "fashion",
      content_goal: "product_showcase",
      tone_style: "humorous",
      tts_speed: 1.2,
      custom_content_domain: "streetwear",
      custom_content_goal: "new collection"
    }),
    {
      contentDomain: "fashion",
      contentGoal: "product_showcase",
      toneStyle: "humorous",
      ttsSpeed: 1.2,
      customContentDomain: "streetwear",
      customContentGoal: "new collection"
    }
  );
});
