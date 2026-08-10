import { AppError } from "./errors.js";
import { createOAuthState, verifyOAuthState } from "./social-crypto.js";
import { socialConfig, socialFeatureStatus } from "./social-config.js";
import { formBody, socialFetchJson } from "./social-http.js";
import { upsertSocialAccount } from "./social-store.js";

const INSTAGRAM_PUBLISH_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

function requireReady(provider) {
  const status = socialFeatureStatus();
  if (provider === "instagram" && !status.instagramOAuthReady) {
    throw new AppError("INSTAGRAM_OAUTH_NOT_CONFIGURED", "Chưa cấu hình INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET và Social secrets.", 503);
  }
  if (provider === "tiktok" && !status.tiktokOAuthReady) {
    throw new AppError("TIKTOK_OAUTH_NOT_CONFIGURED", "Chưa cấu hình TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET và Social secrets.", 503);
  }
}

export function ensureConfiguredFacebookPageAccount() {
  if (!socialFeatureStatus().facebookPageReady) return null;
  return upsertSocialAccount({
    platform: "facebook",
    externalAccountId: socialConfig.facebookPageId,
    accountName: socialConfig.facebookPageName || `Facebook Page ${socialConfig.facebookPageId}`,
    accessToken: socialConfig.facebookPageAccessToken,
    scopes: ["pages_manage_posts"],
    metadata: {
      credentialSource: "env",
      managedByEnv: true
    }
  });
}

export function instagramOAuthUrl(projectId) {
  requireReady("instagram");
  const query = new URLSearchParams({
    client_id: socialConfig.instagramAppId,
    redirect_uri: socialConfig.instagramRedirectUri,
    response_type: "code",
    scope: INSTAGRAM_PUBLISH_SCOPES.join(","),
    state: createOAuthState({ projectId, provider: "instagram" }),
    enable_fb_login: "0",
    force_authentication: "1"
  });
  return `https://www.instagram.com/oauth/authorize?${query}`;
}

async function exchangeInstagramCode(code) {
  const body = new FormData();
  body.set("client_id", socialConfig.instagramAppId);
  body.set("client_secret", socialConfig.instagramAppSecret);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", socialConfig.instagramRedirectUri);
  body.set("code", String(code || ""));
  const short = await socialFetchJson("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body
  });
  if (!short.access_token || !short.user_id) {
    throw new AppError("INSTAGRAM_OAUTH_FAILED", "Instagram không trả access token/user_id.", 400);
  }

  const query = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: socialConfig.instagramAppSecret,
    access_token: short.access_token
  });
  const longLived = await socialFetchJson(`https://graph.instagram.com/access_token?${query}`);
  if (!longLived.access_token) {
    throw new AppError("INSTAGRAM_LONG_LIVED_TOKEN_FAILED", "Instagram không trả long-lived access token.", 400);
  }
  return {
    accessToken: longLived.access_token,
    userId: String(short.user_id),
    expiresIn: Number(longLived.expires_in) || 0
  };
}

async function instagramProfile(userId, accessToken) {
  const query = new URLSearchParams({
    fields: "user_id,username,name,account_type",
    access_token: accessToken
  });
  try {
    return await socialFetchJson(`https://graph.instagram.com/${socialConfig.instagramGraphVersion}/${encodeURIComponent(userId)}?${query}`);
  } catch {
    return {};
  }
}

export async function completeInstagramOAuth({ code, state }) {
  requireReady("instagram");
  const verified = verifyOAuthState(state, "instagram");
  const token = await exchangeInstagramCode(code);
  const profile = await instagramProfile(token.userId, token.accessToken);
  const username = String(profile.username || "").trim();
  const account = upsertSocialAccount({
    platform: "instagram",
    externalAccountId: token.userId,
    accountName: username ? `@${username}` : (String(profile.name || "").trim() || `Instagram ${token.userId}`),
    accessToken: token.accessToken,
    tokenExpiresAt: token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null,
    scopes: INSTAGRAM_PUBLISH_SCOPES,
    metadata: {
      credentialSource: "instagram-login",
      accountType: profile.account_type || "",
      username
    }
  });
  return { projectId: verified.projectId, accounts: [account] };
}

export async function refreshInstagramAccessToken(accessToken) {
  const query = new URLSearchParams({
    grant_type: "ig_refresh_token",
    access_token: String(accessToken || "")
  });
  const value = await socialFetchJson(`https://graph.instagram.com/refresh_access_token?${query}`);
  if (!value.access_token) throw new AppError("INSTAGRAM_REFRESH_FAILED", "Không thể refresh Instagram access token.", 401);
  return {
    accessToken: value.access_token,
    expiresIn: Number(value.expires_in) || 0
  };
}

export function tiktokOAuthUrl(projectId) {
  requireReady("tiktok");
  const query = new URLSearchParams({
    client_key: socialConfig.tiktokClientKey,
    redirect_uri: socialConfig.tiktokRedirectUri,
    response_type: "code",
    scope: "user.info.basic,video.upload",
    state: createOAuthState({ projectId, provider: "tiktok" })
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${query}`;
}

async function exchangeTikTokCode(code) {
  const value = await socialFetchJson("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_key: socialConfig.tiktokClientKey,
      client_secret: socialConfig.tiktokClientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: socialConfig.tiktokRedirectUri
    })
  });
  if (!value.access_token || !value.open_id) throw new AppError("TIKTOK_OAUTH_FAILED", "TikTok không trả access token/open_id.", 400);
  return value;
}

export async function completeTikTokOAuth({ code, state }) {
  requireReady("tiktok");
  const verified = verifyOAuthState(state, "tiktok");
  const token = await exchangeTikTokCode(code);
  const profile = await socialFetchJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", {
    headers: { Authorization: `Bearer ${token.access_token}` }
  });
  if (profile?.error?.code && profile.error.code !== "ok") throw new AppError("TIKTOK_PROFILE_FAILED", `TikTok: ${profile.error.message || profile.error.code}`, 400);
  const user = profile?.data?.user || {};
  const account = upsertSocialAccount({
    platform: "tiktok",
    externalAccountId: String(token.open_id),
    accountName: user.display_name || `TikTok ${token.open_id}`,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    tokenExpiresAt: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
    scopes: String(token.scope || "").split(",").map(item => item.trim()).filter(Boolean),
    metadata: { unionId: user.union_id || token.union_id || "", avatarUrl: user.avatar_url || "" }
  });
  return { projectId: verified.projectId, accounts: [account] };
}
