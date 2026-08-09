import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { FALLBACK_FAMILY, FONT_FILES, fontStack } from "./fonts.js";
import { characterWidth, hasMetrics, missingGlyphs } from "./font-metrics.js";

const VIETNAMESE_SAMPLE = "Top 5 brand Việt mua mà thấy đáng tiền ăn ưở ệỹ";

test("metrics load for every bundled font family", () => {
  for (const family of Object.keys(FONT_FILES)) assert.ok(hasMetrics(family), `không đọc được metric của ${family}`);
});

test("the fallback family itself covers Vietnamese", () => {
  assert.deepEqual(missingGlyphs(FALLBACK_FAMILY, VIETNAMESE_SAMPLE), [],
    "font dự phòng phải phủ đủ tiếng Việt, nếu không thì không có gì đỡ cho các font thiếu glyph");
});

test("character width follows the real font instead of one fixed ratio", () => {
  const size = 72;
  const widths = new Map(Object.keys(FONT_FILES).map(family =>
    [family, [...VIETNAMESE_SAMPLE].reduce((total, character) => total + characterWidth(character, size, family), 0)]));
  // Hệ số cố định 0.55em cũ cho mọi font một con số duy nhất; metric thật phải phân tán.
  assert.ok(new Set([...widths.values()].map(width => Math.round(width))).size > 1, "mọi font vẫn ra cùng một bề rộng");
  const narrowest = Math.min(...widths.values()), widest = Math.max(...widths.values());
  assert.ok(widest / narrowest > 1.2, `chênh lệch bề rộng giữa các font quá nhỏ (${narrowest.toFixed(0)}…${widest.toFixed(0)})`);
});

test("characters missing from a font are measured with the fallback that will draw them", () => {
  // Bebas Neue không có "ệ" dựng sẵn nên glyph đến từ font dự phòng — bề rộng phải lấy theo font đó.
  const lacking = Object.keys(FONT_FILES).find(family => missingGlyphs(family, "ệ").length > 0);
  assert.ok(lacking, "cần ít nhất một font thiếu glyph tiếng Việt để kiểm tra đường dự phòng");
  assert.equal(characterWidth("ệ", 72, lacking), characterWidth("ệ", 72, FALLBACK_FAMILY));
  // Ký tự có sẵn thì vẫn đo bằng chính font đó.
  assert.notEqual(characterWidth("T", 72, lacking), characterWidth("T", 72, FALLBACK_FAMILY));
});

test("the browser preview declares the same font stack as the renderer", async () => {
  const previewDom = await fs.readFile(new URL("../public/preview-dom.js", import.meta.url), "utf8");
  const declared = previewDom.match(/const FALLBACK_FONT = "([^"]+)";/u);
  assert.ok(declared, "không tìm thấy FALLBACK_FONT trong preview-dom.js");
  assert.equal(declared[1], FALLBACK_FAMILY, "font dự phòng của preview và của renderer phải trùng nhau");
});

test("font stack keeps the chosen family first and never repeats the fallback", () => {
  assert.deepEqual(fontStack("Bebas Neue"), ["Bebas Neue", FALLBACK_FAMILY, "sans-serif"]);
  assert.deepEqual(fontStack(FALLBACK_FAMILY), [FALLBACK_FAMILY, "sans-serif"]);
  assert.deepEqual(fontStack(""), [FALLBACK_FAMILY, "sans-serif"]);
});

test("unknown families degrade to the estimate instead of throwing", () => {
  const width = characterWidth("A", 100, "Khong Ton Tai 12345");
  assert.ok(Number.isFinite(width) && width > 0);
});
