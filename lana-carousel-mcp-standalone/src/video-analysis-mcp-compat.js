import {AppError} from "./errors.js";

const BRIEF_ARG_KEYS = [
  "content_domain",
  "content_goal",
  "tone_style",
  "tts_speed",
  "custom_content_domain",
  "custom_content_goal"
];
const REQUIRED_BRIEF_ARG_KEYS = ["content_domain", "tone_style", "tts_speed"];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function briefFromArgs(args = {}) {
  const hasAnyBriefField = BRIEF_ARG_KEYS.some(key => hasOwn(args, key));
  if (!hasAnyBriefField) return null;

  const missingRequiredFields = REQUIRED_BRIEF_ARG_KEYS.filter(key => args[key] === undefined);
  if (missingRequiredFields.length) {
    throw new AppError(
      "VIDEO_ANALYSIS_BRIEF_INCOMPLETE",
      "Content brief phải có đủ content_domain, tone_style và tts_speed.",
      422
    );
  }

  return {
    contentDomain: args.content_domain,
    contentGoal: args.content_goal,
    toneStyle: args.tone_style,
    ttsSpeed: args.tts_speed,
    customContentDomain: args.custom_content_domain,
    customContentGoal: args.custom_content_goal
  };
}
