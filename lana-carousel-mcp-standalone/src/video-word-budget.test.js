import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { BASE_WORDS_PER_SECOND, WORD_BUDGET_RESERVED_SECONDS, countVideoWords } from "./video-analysis-brief.js";

// Studio là script thuần trong trình duyệt nên không import được module server. Chạy nó trong
// một sandbox rồi đối chiếu với hằng số phía server: badge trong studio phải nói đúng thứ mà
// phía render sẽ làm, nếu hai bên lệch nhau thì test này hỏng.
const source = await fs.readFile(new URL("../public/video-word-budget.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const budget = sandbox.window.LanaWordBudget;

test("the studio shares the server word-budget constants", () => {
 assert.equal(budget.BASE_WORDS_PER_SECOND, BASE_WORDS_PER_SECOND);
 assert.equal(budget.WORD_BUDGET_RESERVED_SECONDS, WORD_BUDGET_RESERVED_SECONDS);
});

test("the studio counts words exactly like the server does", () => {
 for (const text of ["", "   ", "một hai ba", " nhiều   khoảng\ttrắng \n xuống dòng "]) {
  assert.equal(budget.countWords(text), countVideoWords(text), `khác nhau ở: ${JSON.stringify(text)}`);
 }
});

test("the budget matches the server formula for the same segment", () => {
 for (const [duration, speed] of [[4, 1], [4, 1.5], [2.5, 0.8], [10, 2]]) {
  const usableDuration = Math.max(0, duration - WORD_BUDGET_RESERVED_SECONDS);
  const expected = Math.max(0, Math.floor(usableDuration * BASE_WORDS_PER_SECOND * speed + 1e-9));
  assert.equal(budget.segmentWordBudget({ start: 0, end: duration, text: "x", ttsSpeed: speed }).maxWords, expected);
 }
});

test("short segments under one word capacity have zero word budget", () => {
 assert.equal(budget.segmentWordBudget({ start: 0, end: 0.2, text: "x", ttsSpeed: 1 }).maxWords, 0);
 assert.equal(budget.segmentWordBudget({ start: 0, end: 0.3, text: "x", ttsSpeed: 1 }).maxWords, 0);
 assert.equal(budget.segmentWordBudget({ start: 0, end: 0.4, text: "x", ttsSpeed: 1 }).maxWords, 1);
});

test("treats valid zero-capacity segments as over budget instead of invalid duration", () => {
 const withText = budget.segmentWordBudget({ start: 0, end: 0.3, text: "một", ttsSpeed: 1 });
 assert.equal(withText.maxWords, 0);
 assert.equal(withText.status, "over");
 assert.equal(budget.describeBudget(withText), "1/0 từ · quá dài, sẽ bị đọc ép nhanh");

 const empty = budget.segmentWordBudget({ start: 0, end: 0.3, text: "", ttsSpeed: 1 });
 assert.equal(empty.status, "empty");
 assert.equal(budget.describeBudget(empty), "0/0 từ · chưa có lời đọc");

 assert.equal(budget.segmentWordBudget({ start: 5, end: 5, text: "x", ttsSpeed: 1 }).status, "unknown");
});

test("flags a line that cannot be read inside its segment", () => {
 // 4s ở tốc độ 1 cho ngân sách 13 từ. 13 * 0.9 = 11.7 -> 11 là good, 12-13 là tight, 14+ là over.
 const of = text => budget.segmentWordBudget({ start: 0, end: 4, text, ttsSpeed: 1 });
 assert.equal(of("một hai ba bốn năm sáu bảy tám chín mười mười_một").status, "good");
 assert.equal(of("một hai ba bốn năm sáu bảy tám chín mười mười_một mười_hai").status, "tight");
 assert.equal(of("một hai ba bốn năm sáu bảy tám chín mười mười_một mười_hai mười_ba mười_bốn").status, "over");
 assert.equal(of("").status, "empty");
 assert.equal(budget.segmentWordBudget({ start: 5, end: 5, text: "x", ttsSpeed: 1 }).status, "unknown");
});

test("reads the budget back as text the studio can show", () => {
 assert.equal(budget.describeBudget(budget.segmentWordBudget({ start: 0, end: 4, text: "một hai", ttsSpeed: 1 })), "2/13 từ · vừa");
 assert.equal(
  budget.describeBudget(budget.segmentWordBudget({ start: 0, end: 0, text: "một", ttsSpeed: 1 })),
  "cần thời lượng hợp lệ"
 );
});
