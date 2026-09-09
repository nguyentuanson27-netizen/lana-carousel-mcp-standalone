// Cùng công thức với src/video-analysis-brief.js. Hai bên phải khớp nhau, nếu không studio sẽ
// báo "vừa" cho câu mà phía render tính là quá dài; có test đối chiếu để chặn lệch.
(function (global) {
  const BASE_WORDS_PER_SECOND = 3.3;
  const WORD_BUDGET_RESERVED_SECONDS = 0;
  const TIGHT_RATIO = 0.9;

  const countWords = value => String(value || "").trim().split(/\s+/u).filter(Boolean).length;

  function segmentWordBudget({ start, end, text, ttsSpeed = 1 }) {
    const duration = Math.max(0, Number(end) - Number(start));
    const usableDuration = Math.max(0, duration - WORD_BUDGET_RESERVED_SECONDS);
    const speed = Math.max(0.5, Number(ttsSpeed) || 1);
    const maxWords = Math.max(0, Math.floor(usableDuration * BASE_WORDS_PER_SECOND * speed + 1e-9));
    const wordCount = countWords(text);
    const status = duration <= 0 ? "unknown"
      : !wordCount ? "empty"
      : wordCount > maxWords ? "over"
      : wordCount > Math.floor(maxWords * TIGHT_RATIO) ? "tight"
      : "good";
    return { duration, usableDuration, wordCount, maxWords, status };
  }

  const STATUS_LABELS = {
    good: "vừa",
    tight: "sát giới hạn",
    over: "quá dài, sẽ bị đọc ép nhanh",
    empty: "chưa có lời đọc",
    unknown: "cần thời lượng hợp lệ"
  };

  global.LanaWordBudget = {
    BASE_WORDS_PER_SECOND,
    WORD_BUDGET_RESERVED_SECONDS,
    countWords,
    segmentWordBudget,
    describeBudget(budget) {
      if (budget.status === "unknown") return STATUS_LABELS.unknown;
      return `${budget.wordCount}/${budget.maxWords} từ · ${STATUS_LABELS[budget.status]}`;
    }
  };
})(window);
