import { AppError } from "./errors.js";
import { createOAuthState, verifyOAuthState } from "./social-crypto.js";
import { socialConfig, socialFeatureStatus } from "./social-config.js";
import { formBody, socialFetchJson } from "./social-http.js";
import { upsertSocialAccount } from "./social-store.js";

function requireReady(provider) {
  const status = socialFeatureStatus();
  if (provider === "meta" && !status.metaOAuthReady) throw new AppError("META_OAUTH_NOT_CONFIGURED", "Chưa cấu hình META_APP_ID/META_APP_SECRET và Social secrets.", 503);
  if (provider === "tiktok" && !status.tiktokOAuthReady) throw new AppError("TIKTOK_OAUTH_NOT_CONFIGURED", "Chưa cấu hình TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET và Social secrets.", 503);
}

export function metaOAuthUrl(projectId) {
  requireReady("meta");
  const query = new URLSearchParams({
    client_id: socialConfig.metaAppId,
    redirect_uri: socialConfig.metaRedirectUri,
    state: createOAuthState({ projectId, provider: "meta" }),
    response_type: "code",
    scope: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publish"
    ].join(",")
  });
  return `https://www.facebook.com/${socialConfig.metaGraphVersion}/dialog/oauth?${query}`;
}

async function exchangeMetaCode(code) {
  const query = new URLSearchParams({
    client_id: socialConfig.metaAppId,
    client_secret: socialConfig.metaAppSecret,
    redirect_uri: socialConfig.metaRedirectUri,
    code
  });
  const short = await socialFetchJson(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/oauth/access_token?${query}`);
  if (!short.access_token) throw new AppError("META_OAUTH_FAILED", "Meta không trả access token.", 400);
  try {
    const longQuery = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: socialConfig.metaAppId,
      client_secret: socialConfig.metaAppSecret,
      fb_exchange_token: short.access_token
    });
    const long = await socialFetchJson(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/oauth/access_token?${longQuery}`);
    return long.access_token || short.access_token;
  } catch {
    return short.access_token;
  }
}

export async function completeMetaOAuth({ code, state }) {
  requireReady("meta");
  const verified = verifyOAuthState(state, "meta");
  const userToken = await exchangeMetaCode(code);
  const query = new URLSearchParams({
    fields: "id,name,access_token,tasks,instagram_business_account{id,username,name}",
    access_token: userToken
  });
  const pages = await socialFetchJson(`https://graph.facebook.com/${socialConfig.metaGraphVersion}/me/accounts?${query}`);
  const connected = [];
  for (const page of pages.data || []) {
    if (!page.id || !page.access_token) continue;
    const pageAccount = upsertSocialAccount({
      platform: "facebook",
      externalAccountId: String(page.id),
      accountName: page.name || `Facebook Page ${page.id}`,
      accessToken: page.access_token,
      scopes: ["pages_manage_posts", "pages_read_engagement"],
      metadata: { tasks: page.tasks || [] }
    });
    connected.push(pageAccount);
    const instagram = page.instagram_business_account;
    if (instagram?.id) {
      connected.push(upsertSocialAccount({
        platform: "instagram",
        externalAccountId: String(instagram.id),
        accountName: instagram.username ? `@${instagram.username}` : (instagram.name || `Instagram ${instagram.id}`),
        accessToken: page.access_token,
        scopes: ["instagram_basic", "instagram_content_publish"],
        metadata: { facebookPageId: String(page.id), facebookPageName: page.name || "" }
      }));
    }
  }
  if (!connected.length) throw new AppError("META_NO_PUBLISHING_ACCOUNT", "Không tìm thấy Facebook Page/Instagram Professional có quyền publish.", 400);
  return { projectId: verified.projectId, accounts: connected };
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
