import { AppError } from "./errors.js";
import { socialFetchJson } from "./social-http.js";

const apiBase = "https://open.tiktokapis.com";

function ensureTikTokOk(value) {
  if (value?.error?.code && value.error.code !== "ok") {
    throw new AppError("TIKTOK_PROVIDER_ERROR", `TikTok: ${value.error.message || value.error.code}`, 400);
  }
  return value;
}

export function buildTikTokPhotoDraftPayload({ images, caption }) {
  return {
    post_info: {
      title: String(caption || "").slice(0, 90),
      description: String(caption || "").slice(0, 2200)
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 1,
      photo_images: images.slice(0, 10).map(item => item.url)
    },
    post_mode: "MEDIA_UPLOAD",
    media_type: "PHOTO"
  };
}

async function postJson(path, accessToken, body) {
  return ensureTikTokOk(await socialFetchJson(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(body)
  }));
}

async function uploadVideoDraft({ account, media }) {
  if (!media.video?.url) throw new AppError("SOCIAL_MEDIA_MISSING", "Không có MP4 READY để gửi TikTok.", 409);
  const result = await postJson("/v2/post/publish/inbox/video/init/", account.accessToken, {
    source_info: {
      source: "PULL_FROM_URL",
      video_url: media.video.url
    }
  });
  if (!result?.data?.publish_id) throw new AppError("TIKTOK_UPLOAD_FAILED", "TikTok không trả publish_id.", 502);
  return {
    remoteId: result.data.publish_id,
    remoteUrl: null,
    providerState: { publishId: result.data.publish_id, mode: "MEDIA_UPLOAD", mediaType: "VIDEO" },
    status: "AWAITING_USER"
  };
}

async function uploadPhotoDraft({ account, media, caption }) {
  if (!media.images?.length) throw new AppError("SOCIAL_MEDIA_MISSING", "Không có ảnh Carousel để gửi TikTok.", 409);
  const result = await postJson("/v2/post/publish/content/init/", account.accessToken, buildTikTokPhotoDraftPayload({ images: media.images, caption }));
  if (!result?.data?.publish_id) throw new AppError("TIKTOK_UPLOAD_FAILED", "TikTok không trả publish_id.", 502);
  return {
    remoteId: result.data.publish_id,
    remoteUrl: null,
    providerState: { publishId: result.data.publish_id, mode: "MEDIA_UPLOAD", mediaType: "PHOTO" },
    status: "AWAITING_USER"
  };
}

export async function publishTikTokDraft({ account, contentType, media, caption }) {
  return contentType === "video"
    ? uploadVideoDraft({ account, media })
    : uploadPhotoDraft({ account, media, caption });
}

export async function fetchTikTokPublishStatus(accessToken, publishId) {
  const value = await postJson("/v2/post/publish/status/fetch/", accessToken, { publish_id: publishId });
  return value.data || {};
}
