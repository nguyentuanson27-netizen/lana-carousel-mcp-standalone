import { AppError } from "./errors.js";
import { getProject } from "./service-core.js";
import { socialFeatureStatus, socialConfig } from "./social-config.js";
import { formBody, socialFetchJson } from "./social-http.js";
import { ensureConfiguredFacebookPageAccount, refreshInstagramAccessToken } from "./social-oauth.js";
import {
  createSocialMediaSnapshot,
  latestReadyVideoJob,
  purgeOrphanedSocialMediaSnapshots,
  removeSocialMediaSnapshot,
  socialCarouselMedia,
  socialMediaFromSnapshot
} from "./social-media.js";
import { publishMetaDelivery } from "./social-provider-meta.js";
import { fetchTikTokPublishStatus, publishTikTokDraft } from "./social-provider-tiktok.js";
import {
  createSocialPost,
  deleteSocialAccount,
  getSocialAccount,
  getSocialDelivery,
  getSocialPost,
  listRunnableDeliveries,
  listSocialAccounts,
  listSocialPosts,
  recomputeSocialPostStatus,
  recordSocialEvent,
  resetSocialDeliveryForRetry,
  updateSocialAccountTokens,
  updateSocialDelivery
} from "./social-store.js";

const active = new Set();
let pumpScheduled = false;

function captionFor(post, platform) {
  return String(post.captions?.[platform] || post.caption || "").trim();
}

function isEnvManagedFacebookAccount(account) {
  return account?.platform === "facebook" &&
    account?.metadata?.credentialSource === "env" &&
    account?.metadata?.managedByEnv === true;
}

function isActiveEnvFacebookAccount(account, feature = socialFeatureStatus()) {
  return isEnvManagedFacebookAccount(account) &&
    feature.facebookPageReady === true &&
    account.externalAccountId === socialConfig.facebookPageId;
}

function isStaleEnvFacebookAccount(account, feature = socialFeatureStatus()) {
  return isEnvManagedFacebookAccount(account) && !isActiveEnvFacebookAccount(account, feature);
}

function isLegacyInstagramAccount(account) {
  return account?.platform === "instagram" && account?.metadata?.credentialSource !== "instagram-login";
}

function assertAccountPublishable(account, feature = socialFeatureStatus()) {
  if (isStaleEnvFacebookAccount(account, feature)) {
    throw new AppError(
      "SOCIAL_FACEBOOK_CREDENTIAL_STALE",
      "Facebook Page credential này không còn khớp cấu hình server; hãy ngắt account cũ hoặc cấu hình lại đúng Page trước khi publish.",
      409
    );
  }
  if (isLegacyInstagramAccount(account)) {
    throw new AppError("INSTAGRAM_RECONNECT_REQUIRED", "Instagram account này được kết nối bằng Facebook Login cũ; hãy ngắt và kết nối lại bằng Instagram Login.", 409);
  }
}

function accountForOverview(account, feature) {
  if (!isStaleEnvFacebookAccount(account, feature)) return account;
  return {
    ...account,
    metadata: {
      ...account.metadata,
      managedByEnv: false,
      staleManagedByEnv: true,
      publishable: false
    }
  };
}

async function refreshTikTokAccount(account) {
  if (account.platform !== "tiktok" || !account.refreshToken) return account;
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now() + 5 * 60_000) return account;
  const value = await socialFetchJson("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_key: socialConfig.tiktokClientKey,
      client_secret: socialConfig.tiktokClientSecret,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken
    })
  });
  if (!value.access_token) throw new AppError("TIKTOK_REFRESH_FAILED", "Không thể refresh TikTok access token.", 401);
  return updateSocialAccountTokens(account.id, {
    accessToken: value.access_token,
    refreshToken: value.refresh_token || account.refreshToken,
    tokenExpiresAt: value.expires_in ? new Date(Date.now() + Number(value.expires_in) * 1000).toISOString() : null,
    scopes: String(value.scope || account.scopes.join(",")).split(",").map(item => item.trim()).filter(Boolean)
  });
}

async function refreshInstagramAccount(account) {
  if (account.platform !== "instagram") return account;
  const expiresAt = account.tokenExpiresAt ? new Date(account.tokenExpiresAt).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now() + 7 * 24 * 60 * 60_000) return account;
  const value = await refreshInstagramAccessToken(account.accessToken);
  return updateSocialAccountTokens(account.id, {
    accessToken: value.accessToken,
    refreshToken: account.refreshToken,
    tokenExpiresAt: value.expiresIn ? new Date(Date.now() + value.expiresIn * 1000).toISOString() : null,
    scopes: account.scopes
  });
}

async function accountForDelivery(delivery) {
  if (!delivery.accountId) throw new AppError("SOCIAL_ACCOUNT_DISCONNECTED", `Tài khoản ${delivery.accountName} đã bị ngắt kết nối.`, 409);
  const account = getSocialAccount(delivery.accountId, { includeSecrets: true });
  if (!account) throw new AppError("SOCIAL_ACCOUNT_NOT_FOUND", `Không tìm thấy tài khoản ${delivery.accountName}.`, 404);
  assertAccountPublishable(account);
  if (account.platform === "tiktok") return refreshTikTokAccount(account);
  if (account.platform === "instagram") return refreshInstagramAccount(account);
  return account;
}

export async function processSocialDelivery(deliveryId) {
  if (active.has(deliveryId)) return getSocialDelivery(deliveryId);
  active.add(deliveryId);
  let delivery = getSocialDelivery(deliveryId);
  try {
    if (!delivery || delivery.status !== "QUEUED") return delivery;
    const post = getSocialPost(delivery.postId);
    if (!post) throw new AppError("SOCIAL_POST_NOT_FOUND", "Không tìm thấy kế hoạch đăng.", 404);
    delivery = updateSocialDelivery(delivery.id, {
      status: "PROCESSING",
      attemptCount: delivery.attemptCount + 1,
      error: null
    });
    recordSocialEvent(post.id, delivery.id, "DELIVERY_STARTED", { attempt: delivery.attemptCount, platform: delivery.platform });

    const account = await accountForDelivery(delivery);
    const media = socialMediaFromSnapshot(post);
    const caption = captionFor(post, delivery.platform);
    const result = delivery.platform === "tiktok"
      ? await publishTikTokDraft({ account, contentType: post.contentType, media, caption })
      : await publishMetaDelivery({
          account,
          contentType: post.contentType,
          media,
          caption,
          projectTitle: post.mediaSnapshot?.projectTitle || "Lana Content Studio"
        });

    const status = result.status || "PUBLISHED";
    delivery = updateSocialDelivery(delivery.id, {
      status,
      remoteId: result.remoteId || null,
      remoteUrl: result.remoteUrl || null,
      providerState: result.providerState || {},
      error: null,
      completedAt: new Date().toISOString()
    });
    recordSocialEvent(post.id, delivery.id, status === "AWAITING_USER" ? "DELIVERY_UPLOADED_TO_DRAFT" : "DELIVERY_PUBLISHED", {
      remoteId: delivery.remoteId,
      platform: delivery.platform,
      mediaSnapshotId: post.mediaSnapshot?.snapshotId || null
    });
    recomputeSocialPostStatus(post.id);
    return delivery;
  } catch (error) {
    if (delivery) {
      const message = error?.message || "Đăng mạng xã hội thất bại.";
      updateSocialDelivery(delivery.id, {
        status: "FAILED",
        error: message.slice(0, 1000),
        completedAt: new Date().toISOString()
      });
      recordSocialEvent(delivery.postId, delivery.id, "DELIVERY_FAILED", { message: message.slice(0, 500) });
      recomputeSocialPostStatus(delivery.postId);
    }
    throw error;
  } finally {
    active.delete(deliveryId);
  }
}

export function scheduleSocialPump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  queueMicrotask(async () => {
    try {
      for (const delivery of listRunnableDeliveries(6)) {
        await processSocialDelivery(delivery.id).catch(error => console.error("Social delivery failed", delivery.id, error?.message || error));
      }
    } finally {
      pumpScheduled = false;
    }
  });
}

export async function createPublishPost({ projectId, contentType, caption = "", captions = {}, accountIds }) {
  getProject(projectId);
  const uniqueIds = [...new Set(accountIds || [])];
  if (!uniqueIds.length) throw new AppError("SOCIAL_ACCOUNT_REQUIRED", "Hãy chọn ít nhất một tài khoản mạng xã hội.", 400);
  const accounts = uniqueIds.map(id => getSocialAccount(id)).filter(Boolean);
  if (accounts.length !== uniqueIds.length) throw new AppError("SOCIAL_ACCOUNT_NOT_FOUND", "Một tài khoản MXH không còn tồn tại.", 404);
  const feature = socialFeatureStatus();
  for (const account of accounts) assertAccountPublishable(account, feature);
  if (!new Set(["carousel", "video"]).has(contentType)) {
    throw new AppError("SOCIAL_CONTENT_TYPE_INVALID", "Loại nội dung Social không hợp lệ.", 400);
  }

  let mediaSnapshot;
  try {
    mediaSnapshot = await createSocialMediaSnapshot(projectId, contentType);
    const post = createSocialPost({ projectId, contentType, caption, captions, mediaSnapshot, accounts });
    scheduleSocialPump();
    return post;
  } catch (error) {
    if (mediaSnapshot) await removeSocialMediaSnapshot(mediaSnapshot);
    throw error;
  }
}

export function retrySocialDelivery({ projectId, deliveryId }) {
  const delivery = getSocialDelivery(deliveryId);
  if (!delivery) throw new AppError("SOCIAL_DELIVERY_NOT_FOUND", "Không tìm thấy delivery.", 404);
  const post = getSocialPost(delivery.postId);
  if (!post || post.projectId !== projectId) throw new AppError("SOCIAL_DELIVERY_NOT_FOUND", "Delivery không thuộc dự án này.", 404);
  if (!post.mediaSnapshot?.snapshotId) throw new AppError("SOCIAL_MEDIA_SNAPSHOT_MISSING", "Lượt đăng cũ không có media snapshot để retry an toàn.", 409);
  const reset = resetSocialDeliveryForRetry(deliveryId);
  if (!reset) throw new AppError("SOCIAL_DELIVERY_NOT_RETRYABLE", "Chỉ delivery FAILED mới được retry.", 409);
  recomputeSocialPostStatus(post.id);
  scheduleSocialPump();
  return getSocialPost(post.id);
}

export async function refreshTikTokDelivery({ projectId, deliveryId }) {
  const delivery = getSocialDelivery(deliveryId);
  if (!delivery || delivery.platform !== "tiktok") throw new AppError("SOCIAL_DELIVERY_NOT_FOUND", "Không tìm thấy TikTok delivery.", 404);
  const post = getSocialPost(delivery.postId);
  if (!post || post.projectId !== projectId) throw new AppError("SOCIAL_DELIVERY_NOT_FOUND", "Delivery không thuộc dự án này.", 404);
  if (!delivery.remoteId) return delivery;
  const account = await accountForDelivery(delivery);
  const status = await fetchTikTokPublishStatus(account.accessToken, delivery.remoteId);
  const publicIds = status.publicaly_available_post_id || status.publicly_available_post_id || [];
  if (status.status === "FAILED") {
    updateSocialDelivery(delivery.id, { status: "FAILED", error: status.fail_reason || "TikTok xử lý draft thất bại.", completedAt: new Date().toISOString() });
  } else if (status.status === "PUBLISH_COMPLETE" && publicIds.length) {
    updateSocialDelivery(delivery.id, { status: "PUBLISHED", remoteId: String(publicIds[0]), error: null, completedAt: new Date().toISOString(), providerState: { ...delivery.providerState, publishStatus: status } });
  } else {
    updateSocialDelivery(delivery.id, { status: "AWAITING_USER", providerState: { ...delivery.providerState, publishStatus: status }, error: null });
  }
  recomputeSocialPostStatus(post.id);
  return getSocialDelivery(delivery.id);
}

export function socialOverview(projectId) {
  ensureConfiguredFacebookPageAccount();
  const project = getProject(projectId);
  const feature = socialFeatureStatus();
  let carouselReady = false;
  let carouselReason = null;
  try { socialCarouselMedia(projectId); carouselReady = true; }
  catch (error) { carouselReason = error?.message || "Carousel chưa sẵn sàng."; }
  const videoJob = latestReadyVideoJob(projectId);
  return {
    project: { id: project.id, title: project.title },
    feature,
    accounts: listSocialAccounts().map(account => accountForOverview(account, feature)),
    readiness: {
      carousel: { ready: carouselReady, reason: carouselReason },
      video: { ready: Boolean(videoJob), jobId: videoJob?.id || null }
    },
    posts: listSocialPosts(projectId, 20)
  };
}

export function disconnectSocialAccount(accountId) {
  const account = getSocialAccount(accountId);
  if (!account) throw new AppError("SOCIAL_ACCOUNT_NOT_FOUND", "Không tìm thấy tài khoản MXH.", 404);
  if (isActiveEnvFacebookAccount(account)) {
    throw new AppError("SOCIAL_ACCOUNT_MANAGED_BY_ENV", "Facebook Page nội bộ đang được quản lý bằng biến môi trường; hãy xóa credential trên server và restart trước khi ngắt account này.", 409);
  }
  deleteSocialAccount(accountId);
  return { success: true, id: accountId };
}

ensureConfiguredFacebookPageAccount();
purgeOrphanedSocialMediaSnapshots().catch(error => console.error("Initial social media snapshot cleanup failed", error));
setTimeout(scheduleSocialPump, 250).unref?.();
const socialPumpTimer = setInterval(scheduleSocialPump, 15_000);
socialPumpTimer.unref();
const socialSnapshotCleanupTimer = setInterval(() => {
  purgeOrphanedSocialMediaSnapshots().catch(error => console.error("Social media snapshot cleanup failed", error));
}, 6 * 60 * 60 * 1000);
socialSnapshotCleanupTimer.unref();
