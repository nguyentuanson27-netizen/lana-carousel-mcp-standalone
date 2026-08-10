import { AppError } from "./errors.js";
import { socialConfig } from "./social-config.js";
import { formBody, socialFetchJson } from "./social-http.js";

const facebookGraphBase = () => `https://graph.facebook.com/${socialConfig.metaGraphVersion}`;
const instagramGraphBase = () => `https://graph.instagram.com/${socialConfig.instagramGraphVersion}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function graphPost(base, path, values, accessToken) {
  return socialFetchJson(`${base()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ ...values, access_token: accessToken })
  });
}

async function graphGet(base, path, values, accessToken) {
  const query = new URLSearchParams({ ...values, access_token: accessToken });
  return socialFetchJson(`${base()}${path}?${query}`);
}

async function instagramContainerStatus(containerId, accessToken) {
  return graphGet(instagramGraphBase, `/${encodeURIComponent(containerId)}`, { fields: "status_code,status" }, accessToken);
}

async function waitForInstagramContainer(containerId, accessToken) {
  const deadline = Date.now() + socialConfig.instagramProcessingTimeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await instagramContainerStatus(containerId, accessToken);
    if (latest.status_code === "FINISHED") return latest;
    if (["ERROR", "EXPIRED"].includes(latest.status_code)) {
      throw new AppError("INSTAGRAM_CONTAINER_FAILED", latest.status || "Instagram không xử lý được media.", 400);
    }
    await sleep(1500);
  }
  throw new AppError("INSTAGRAM_CONTAINER_TIMEOUT", `Instagram chưa xử lý xong media (${latest?.status_code || "IN_PROGRESS"}).`, 504);
}

async function instagramPermalink(mediaId, accessToken) {
  try {
    const value = await graphGet(instagramGraphBase, `/${encodeURIComponent(mediaId)}`, { fields: "permalink" }, accessToken);
    return value.permalink || null;
  } catch { return null; }
}

async function publishInstagramCarousel({ account, media, caption }) {
  if (!media.images?.length) throw new AppError("SOCIAL_MEDIA_MISSING", "Không có ảnh Carousel để đăng Instagram.", 409);
  const childIds = [];
  for (const image of media.images.slice(0, 10)) {
    const child = await graphPost(instagramGraphBase, `/${encodeURIComponent(account.externalAccountId)}/media`, {
      image_url: image.url,
      is_carousel_item: "true"
    }, account.accessToken);
    if (!child.id) throw new AppError("INSTAGRAM_CONTAINER_MISSING", "Instagram không trả container ảnh.", 502);
    childIds.push(child.id);
  }
  const parent = await graphPost(instagramGraphBase, `/${encodeURIComponent(account.externalAccountId)}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption
  }, account.accessToken);
  if (!parent.id) throw new AppError("INSTAGRAM_CONTAINER_MISSING", "Instagram không trả container Carousel.", 502);
  await waitForInstagramContainer(parent.id, account.accessToken);
  const published = await graphPost(instagramGraphBase, `/${encodeURIComponent(account.externalAccountId)}/media_publish`, { creation_id: parent.id }, account.accessToken);
  if (!published.id) throw new AppError("INSTAGRAM_PUBLISH_FAILED", "Instagram không trả media ID sau khi publish.", 502);
  return { remoteId: published.id, remoteUrl: await instagramPermalink(published.id, account.accessToken), providerState: { containerId: parent.id, childIds } };
}

async function publishInstagramReel({ account, media, caption }) {
  if (!media.video?.url) throw new AppError("SOCIAL_MEDIA_MISSING", "Không có MP4 READY để đăng Instagram Reel.", 409);
  const container = await graphPost(instagramGraphBase, `/${encodeURIComponent(account.externalAccountId)}/media`, {
    media_type: "REELS",
    video_url: media.video.url,
    caption,
    share_to_feed: "true"
  }, account.accessToken);
  if (!container.id) throw new AppError("INSTAGRAM_CONTAINER_MISSING", "Instagram không trả Reel container.", 502);
  await waitForInstagramContainer(container.id, account.accessToken);
  const published = await graphPost(instagramGraphBase, `/${encodeURIComponent(account.externalAccountId)}/media_publish`, { creation_id: container.id }, account.accessToken);
  if (!published.id) throw new AppError("INSTAGRAM_PUBLISH_FAILED", "Instagram không trả media ID sau khi publish Reel.", 502);
  return { remoteId: published.id, remoteUrl: await instagramPermalink(published.id, account.accessToken), providerState: { containerId: container.id } };
}

async function publishFacebookPhotos({ account, media, caption }) {
  if (!media.images?.length) throw new AppError("SOCIAL_MEDIA_MISSING", "Không có ảnh Carousel để đăng Facebook.", 409);
  const photoIds = [];
  for (const image of media.images) {
    const photo = await graphPost(facebookGraphBase, `/${encodeURIComponent(account.externalAccountId)}/photos`, {
      url: image.url,
      published: "false"
    }, account.accessToken);
    if (!photo.id) throw new AppError("FACEBOOK_PHOTO_UPLOAD_FAILED", "Facebook không trả photo ID.", 502);
    photoIds.push(photo.id);
  }
  const values = { message: caption };
  photoIds.forEach((id, index) => { values[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id }); });
  const post = await graphPost(facebookGraphBase, `/${encodeURIComponent(account.externalAccountId)}/feed`, values, account.accessToken);
  if (!post.id) throw new AppError("FACEBOOK_PUBLISH_FAILED", "Facebook không trả post ID.", 502);
  const remoteUrl = `https://www.facebook.com/${post.id.replace("_", "/posts/")}`;
  return { remoteId: post.id, remoteUrl, providerState: { photoIds } };
}

async function publishFacebookReel({ account, media, caption, title }) {
  if (!media.video?.url) throw new AppError("SOCIAL_MEDIA_MISSING", "Không có MP4 READY để đăng Facebook Reel.", 409);
  const start = await graphPost(facebookGraphBase, "/me/video_reels", { upload_phase: "start" }, account.accessToken);
  if (!start.video_id || !start.upload_url) throw new AppError("FACEBOOK_REEL_START_FAILED", "Facebook không tạo được phiên upload Reel.", 502);
  const upload = await socialFetchJson(start.upload_url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${account.accessToken}`,
      file_url: media.video.url
    }
  });
  if (upload.success !== true) throw new AppError("FACEBOOK_REEL_UPLOAD_FAILED", "Facebook không nhận được file Reel.", 502);
  const finish = await graphPost(facebookGraphBase, "/me/video_reels", {
    video_id: start.video_id,
    upload_phase: "finish",
    video_state: "PUBLISHED",
    description: caption,
    title: title || "Lana Content Studio"
  }, account.accessToken);
  if (finish.success !== true) throw new AppError("FACEBOOK_REEL_PUBLISH_FAILED", "Facebook không publish được Reel.", 502);
  return { remoteId: start.video_id, remoteUrl: null, providerState: { videoId: start.video_id } };
}

export async function publishMetaDelivery({ account, contentType, media, caption, projectTitle }) {
  if (account.platform === "instagram") {
    return contentType === "video"
      ? publishInstagramReel({ account, media, caption })
      : publishInstagramCarousel({ account, media, caption });
  }
  if (account.platform === "facebook") {
    return contentType === "video"
      ? publishFacebookReel({ account, media, caption, title: projectTitle })
      : publishFacebookPhotos({ account, media, caption });
  }
  throw new AppError("SOCIAL_PLATFORM_UNSUPPORTED", `Không hỗ trợ provider ${account.platform}.`, 400);
}
