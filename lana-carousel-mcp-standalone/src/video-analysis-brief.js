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
export const VIDEO_EDITABLE_SETTING_KEYS = [
  "ttsEnabled", "ttsProvider", "ttsSpeed", "ttsVolume", "ttsVoice",
  "originalAudioVolume", "subtitleEnabled", "subtitleFont", "subtitleSize",
  "subtitleColor", "subtitleBackgroundColor", "subtitleBackgroundOpacity",
  "subtitleX", "subtitlePosition", "subtitleStyle", "geminiSpeaker1Voice",
  "geminiSpeaker2Voice", "geminiSpeaker1Name", "geminiSpeaker2Name",
  "geminiMultiSpeaker", "geminiModel"
];
export const BASE_WORDS_PER_SECOND = 2.5;
export const WORD_BUDGET_SAFETY_FACTOR = 0.85;

const TIMELINE_TOLERANCE_SECONDS = 0.001;
const MIN_DIFFERENT_SEGMENT_RATIO = 0.5;
const MIN_PUNCHY_WORD_REDUCTION_RATIO = 0.1;

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

export function sanitizeVideoAnalysisEditableSettings(settings = {}) {
  const sanitized = {};
  for (const key of VIDEO_EDITABLE_SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) sanitized[key] = settings[key];
  }
  return sanitized;
}

export function countVideoWords(value) {
  return String(value || "").trim().split(/\s+/u).filter(Boolean).length;
}

const optionTargets = optionId => optionId === "natural_full"
  ? {min: 0.8, max: 0.9}
  : {min: 0.55, max: 0.7};

const normalizeText = value => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("vi-VN")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

const segmentContent = segment => normalizeText(`${segment.subtitleText} ${segment.voiceOverText}`);

const normalizeOption = option => ({
  optionId: option.optionId || option.option_id,
  label: String(option.label || "").trim(),
  segments: (option.segments || []).map(segment => ({
    id: String(segment.id || "").trim(),
    start: Number(segment.start),
    end: Number(segment.end),
    subtitleText: String(segment.subtitleText ?? segment.subtitle_text ?? "").trim(),
    voiceOverText: String(segment.voiceOverText ?? segment.voice_over_text ?? "").trim(),
    speaker: segment.speaker || "speaker1",
    enabled: segment.enabled !== false
  }))
});

function validateOptionSegments(option) {
  if (!option.segments.length) {
    throw new AppError("EMPTY_VIDEO_SCRIPT_OPTION", `Phương án ${option.optionId} phải có ít nhất một đoạn.`, 422);
  }

  const ids = new Set();
  for (const segment of option.segments) {
    if (!segment.id) {
      throw new AppError("VIDEO_SCRIPT_SEGMENT_ID_REQUIRED", "Mỗi đoạn trong hai phương án phải có segment id ổn định.", 422);
    }
    if (ids.has(segment.id)) {
      throw new AppError("DUPLICATE_VIDEO_SCRIPT_SEGMENT_ID", `Segment id ${segment.id} bị trùng trong phương án ${option.optionId}.`, 422);
    }
    ids.add(segment.id);
    if (!(segment.start >= 0) || !(segment.end > segment.start)) {
      throw new AppError("INVALID_SEGMENT_TIME", "Thời gian kết thúc phải lớn hơn thời gian bắt đầu.", 422);
    }
    if (!segment.subtitleText || !segment.voiceOverText) {
      throw new AppError("EMPTY_VIDEO_SCRIPT_SEGMENT", "Mỗi đoạn phải có cả phụ đề và voice-over.", 422);
    }
  }
}

function validateSharedTimeline(naturalOption, punchyOption) {
  if (naturalOption.segments.length !== punchyOption.segments.length) {
    throw new AppError("VIDEO_SCRIPT_TIMELINE_MISMATCH", "Hai phương án phải dùng cùng số lượng đoạn và cùng timeline.", 422);
  }

  for (let index = 0; index < naturalOption.segments.length; index += 1) {
    const natural = naturalOption.segments[index];
    const punchy = punchyOption.segments[index];
    const sameTime = Math.abs(natural.start - punchy.start) <= TIMELINE_TOLERANCE_SECONDS
      && Math.abs(natural.end - punchy.end) <= TIMELINE_TOLERANCE_SECONDS;
    if (natural.id !== punchy.id || !sameTime) {
      throw new AppError(
        "VIDEO_SCRIPT_TIMELINE_MISMATCH",
        `Hai phương án phải dùng cùng segment id và timestamp tại vị trí ${index + 1}.`,
        422
      );
    }
    if (natural.enabled !== punchy.enabled) {
      throw new AppError(
        "VIDEO_SCRIPT_ENABLED_STATE_MISMATCH",
        `Hai phương án phải dùng cùng trạng thái bật/tắt tại segment ${natural.id}.`,
        422
      );
    }
  }
}

function enabledSegmentPairs(naturalOption, punchyOption) {
  return naturalOption.segments
    .map((natural, index) => ({natural, punchy: punchyOption.segments[index]}))
    .filter(pair => pair.natural.enabled);
}

function validateDistinctOptions(naturalOption, punchyOption) {
  const activePairs = enabledSegmentPairs(naturalOption, punchyOption);
  if (!activePairs.length) {
    throw new AppError(
      "VIDEO_SCRIPT_OPTIONS_NO_ENABLED_SEGMENTS",
      "Hai phương án phải có ít nhất một segment đang bật để so sánh và render.",
      422
    );
  }

  const naturalWords = activePairs.reduce(
    (total, pair) => total + countVideoWords(pair.natural.voiceOverText || pair.natural.subtitleText),
    0
  );
  const punchyWords = activePairs.reduce(
    (total, pair) => total + countVideoWords(pair.punchy.voiceOverText || pair.punchy.subtitleText),
    0
  );
  const differentSegments = activePairs.reduce((total, pair) => (
    total + (segmentContent(pair.natural) !== segmentContent(pair.punchy) ? 1 : 0)
  ), 0);
  const requiredDifferentSegments = Math.max(1, Math.ceil(activePairs.length * MIN_DIFFERENT_SEGMENT_RATIO));
  const requiredWordGap = naturalWords >= 10
    ? Math.max(1, Math.ceil(naturalWords * MIN_PUNCHY_WORD_REDUCTION_RATIO))
    : 1;

  if (differentSegments < requiredDifferentSegments || naturalWords - punchyWords < requiredWordGap) {
    throw new AppError(
      "VIDEO_SCRIPT_OPTIONS_TOO_SIMILAR",
      "Phương án punchy_short phải ngắn hơn và khác rõ ràng ở ít nhất một nửa số segment đang bật.",
      422
    );
  }
}

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

  for (const option of normalizedOptions) validateOptionSegments(option);
  const naturalOption = normalizedOptions.find(option => option.optionId === "natural_full");
  const punchyOption = normalizedOptions.find(option => option.optionId === "punchy_short");
  validateSharedTimeline(naturalOption, punchyOption);
  validateDistinctOptions(naturalOption, punchyOption);

  const evaluatedOptions = normalizedOptions.map(option => {
    const target = optionTargets(option.optionId);
    let totalWords = 0;
    let totalBudget = 0;
    let overBudgetSegments = 0;

    const segments = option.segments.map(segment => {
      const duration = segment.end - segment.start;
      if (!segment.enabled) {
        return {
          ...segment,
          duration,
          wordCount:0,
          maxWords:0,
          recommendedMinWords:0,
          recommendedMaxWords:0,
          utilization:0,
          fitStatus:"disabled"
        };
      }

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
      formula: "enabled duration × 2.5 words/s × ttsSpeed × 0.85"
    },
    options: evaluatedOptions,
    nextAction: "Hiển thị cả hai phương án cho người dùng và chờ họ chọn rõ một phương án trước khi lưu script."
  };
}
