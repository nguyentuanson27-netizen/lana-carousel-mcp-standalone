import {AppError} from "./errors.js";

export const VIDEO_CONTENT_DOMAINS = [
  "fashion", "beauty", "entertainment", "food", "travel", "technology",
  "education", "business", "lifestyle", "other"
];

export const VIDEO_CONTENT_GOALS = [
  "product_showcase", "sales", "review", "tutorial", "storytelling",
  "entertainment", "brand_awareness", "engagement", "other"
];

export const VIDEO_TONE_STYLES = [
  "humorous", "witty", "friendly", "energetic", "trendy", "luxurious",
  "serious", "expert", "emotional", "storytelling", "persuasive_sales", "minimal"
];

export const VIDEO_TTS_SPEEDS = [0.8, 1, 1.2, 1.5, 1.8, 2];
export const VIDEO_SCRIPT_OPTION_IDS = ["natural_full", "punchy_short"];
export const BASE_WORDS_PER_SECOND = 2.5;
export const WORD_BUDGET_SAFETY_FACTOR = 0.85;

const TONE_PROMPTS = {
  humorous: "Đọc tiếng Việt tự nhiên, hài hước, có nhịp và nhấn đúng punchline.",
  witty: "Đọc tiếng Việt dí dỏm, thông minh, tự nhiên và không cường điệu.",
  friendly: "Đọc tiếng Việt gần gũi, ấm áp và dễ nghe.",
  energetic: "Đọc tiếng Việt năng động, rõ chữ và giàu năng lượng.",
  trendy: "Đọc tiếng Việt hiện đại, bắt nhịp nội dung mạng xã hội nhưng không đọc ký hiệu tốc độ.",
  luxurious: "Đọc tiếng Việt sang trọng, tinh tế, tiết chế và rõ ràng.",
  serious: "Đọc tiếng Việt nghiêm túc, mạch lạc và đáng tin cậy.",
  expert: "Đọc tiếng Việt theo phong cách chuyên gia, rõ ràng và có trọng tâm.",
  emotional: "Đọc tiếng Việt giàu cảm xúc, chân thật và có khoảng nghỉ tự nhiên.",
  storytelling: "Đọc tiếng Việt theo lối kể chuyện cuốn hút, tự nhiên và có cao trào.",
  persuasive_sales: "Đọc tiếng Việt thuyết phục, tự nhiên, nhấn lợi ích nhưng không gây áp lực.",
  minimal: "Đọc tiếng Việt tối giản, gọn, rõ và tiết chế."
};

const ensureAllowed = (value, allowed, code, message) => {
  if (!allowed.includes(value)) throw new AppError(code, message, 422);
  return value;
};

export function normalizeVideoAnalysisBrief(brief, {required = true} = {}) {
  if (!brief) {
    if (!required) return null;
    throw new AppError(
      "VIDEO_ANALYSIS_BRIEF_REQUIRED",
      "Cần chọn chủ đề video, phong cách thể hiện và tốc độ giọng đọc trước khi phân tích.",
      422
    );
  }

  const contentDomain = String(brief.contentDomain || brief.content_domain || "").trim();
  const toneStyle = String(brief.toneStyle || brief.tone_style || "").trim();
  const contentGoalRaw = brief.contentGoal ?? brief.content_goal;
  const contentGoal = contentGoalRaw ? String(contentGoalRaw).trim() : null;
  const ttsSpeed = Number(brief.ttsSpeed ?? brief.tts_speed);

  if (!contentDomain || !toneStyle || !Number.isFinite(ttsSpeed)) {
    throw new AppError(
      "VIDEO_ANALYSIS_BRIEF_REQUIRED",
      "Cần chọn đủ chủ đề video, phong cách thể hiện và tốc độ giọng đọc.",
      422
    );
  }

  ensureAllowed(contentDomain, VIDEO_CONTENT_DOMAINS, "INVALID_VIDEO_CONTENT_DOMAIN", "Chủ đề video không hợp lệ.");
  ensureAllowed(toneStyle, VIDEO_TONE_STYLES, "INVALID_VIDEO_TONE_STYLE", "Phong cách thể hiện không hợp lệ.");
  if (contentGoal) ensureAllowed(contentGoal, VIDEO_CONTENT_GOALS, "INVALID_VIDEO_CONTENT_GOAL", "Mục tiêu nội dung không hợp lệ.");
  if (!VIDEO_TTS_SPEEDS.includes(ttsSpeed)) {
    throw new AppError(
      "INVALID_VIDEO_TTS_SPEED",
      `Tốc độ giọng đọc phải là một trong các mức: ${VIDEO_TTS_SPEEDS.map(value => `x${value}`).join(", ")}.`,
      422
    );
  }

  return {
    contentDomain,
    contentGoal,
    toneStyle,
    ttsSpeed,
    customContentDomain: String(brief.customContentDomain || brief.custom_content_domain || "").trim() || null,
    customContentGoal: String(brief.customContentGoal || brief.custom_content_goal || "").trim() || null
  };
}

export function getVideoTonePrompt(toneStyle) {
  return TONE_PROMPTS[toneStyle] || TONE_PROMPTS.friendly;
}

export function countVideoWords(value) {
  return String(value || "").trim().split(/\s+/u).filter(Boolean).length;
}

const optionTargets = optionId => optionId === "natural_full"
  ? {min: 0.8, max: 0.9}
  : {min: 0.55, max: 0.7};

const normalizeOption = option => ({
  optionId: option.optionId || option.option_id,
  label: String(option.label || "").trim(),
  segments: (option.segments || []).map((segment, index) => ({
    id: segment.id || `segment-${index + 1}`,
    start: Number(segment.start),
    end: Number(segment.end),
    subtitleText: String(segment.subtitleText ?? segment.subtitle_text ?? ""),
    voiceOverText: String(segment.voiceOverText ?? segment.voice_over_text ?? "")
  }))
});

export function evaluateVideoScriptOptions({brief, options}) {
  const analysisBrief = normalizeVideoAnalysisBrief(brief);
  if (!Array.isArray(options) || options.length !== 2) {
    throw new AppError("VIDEO_SCRIPT_OPTIONS_REQUIRED", "Phải tạo đúng 2 phương án phụ đề/voice-over.", 422);
  }

  const normalizedOptions = options.map(normalizeOption);
  const optionIds = normalizedOptions.map(option => option.optionId);
  if (new Set(optionIds).size !== 2 || VIDEO_SCRIPT_OPTION_IDS.some(id => !optionIds.includes(id))) {
    throw new AppError(
      "INVALID_VIDEO_SCRIPT_OPTIONS",
      "Hai phương án bắt buộc là natural_full và punchy_short.",
      422
    );
  }

  const evaluatedOptions = normalizedOptions.map(option => {
    const target = optionTargets(option.optionId);
    let totalWords = 0;
    let totalBudget = 0;
    let overBudgetSegments = 0;

    const segments = option.segments.map(segment => {
      if (!(segment.start >= 0) || !(segment.end > segment.start)) {
        throw new AppError("INVALID_SEGMENT_TIME", "Thời gian kết thúc phải lớn hơn thời gian bắt đầu.", 422);
      }
      const duration = segment.end - segment.start;
      const maxWords = Math.max(1, Math.floor(duration * BASE_WORDS_PER_SECOND * analysisBrief.ttsSpeed * WORD_BUDGET_SAFETY_FACTOR));
      const recommendedMinWords = Math.max(1, Math.floor(maxWords * target.min));
      const recommendedMaxWords = Math.max(recommendedMinWords, Math.floor(maxWords * target.max));
      const wordCount = countVideoWords(segment.voiceOverText || segment.subtitleText);
      const utilization = maxWords ? Number((wordCount / maxWords).toFixed(2)) : 0;
      const fitStatus = wordCount > maxWords ? "too_long" : wordCount > recommendedMaxWords ? "tight" : wordCount < recommendedMinWords ? "short" : "good";
      if (wordCount > maxWords) overBudgetSegments += 1;
      totalWords += wordCount;
      totalBudget += maxWords;
      return {...segment, duration, wordCount, maxWords, recommendedMinWords, recommendedMaxWords, utilization, fitStatus};
    });

    return {
      ...option,
      intent: option.optionId === "natural_full" ? "Tự nhiên, đầy đủ" : "Ngắn, bắt nhịp",
      targetBudgetUsage: target,
      totalWords,
      totalBudget,
      estimatedVoiceDurationSeconds: Number((totalWords / (BASE_WORDS_PER_SECOND * analysisBrief.ttsSpeed)).toFixed(2)),
      overBudgetSegments,
      fitsTimeline: overBudgetSegments === 0,
      segments
    };
  });

  return {
    analysisBrief,
    budgetModel: {
      baseWordsPerSecond: BASE_WORDS_PER_SECOND,
      safetyFactor: WORD_BUDGET_SAFETY_FACTOR,
      formula: "duration × 2.5 words/s × ttsSpeed × 0.85"
    },
    options: evaluatedOptions,
    nextAction: "Hiển thị cả hai phương án cho người dùng và chờ họ chọn rõ một phương án trước khi lưu script."
  };
}
