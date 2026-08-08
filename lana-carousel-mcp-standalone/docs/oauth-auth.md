# Lana OAuth authentication

Lana dùng hai lớp OAuth liên kết với cùng một danh tính người dùng:

1. **Google OAuth/OIDC** để đăng nhập Lana Content Studio trong trình duyệt.
2. **Lana OAuth 2.1 Authorization Server** để các MCP client như ChatGPT lấy access token bằng Authorization Code + PKCE.

API key không còn được dùng cho browser login hoặc endpoint `/mcp`. `API_KEY` / `API_KEYS` chỉ còn là fallback tùy chọn cho REST automation thông qua header `X-API-Key`.

## 1. Google OAuth cho Content Studio

Tạo OAuth 2.0 Client ID loại **Web application** trong Google Cloud Console.

Authorized redirect URI production:

```text
https://content.lanadesign.tech/auth/google/callback
```

Cấu hình `.env`:

```env
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
OAUTH_ALLOWED_EMAILS=owner@example.com
# hoặc cho phép cả Google Workspace domain:
# OAUTH_ALLOWED_DOMAINS=lanadesign.vn
```

Để bật browser login và MCP OAuth trên production, cần cấu hình đủ Google client và ít nhất một allowlist email/domain. Trong giai đoạn rollout, process production cũ vẫn được phép khởi động tạm thời nếu còn `API_KEY`, nhưng API key đó **không** đăng nhập được Content Studio và **không** kết nối được `/mcp`; nó chỉ còn phục vụ REST automation qua `X-API-Key`.

Lana kiểm tra `email_verified` từ Google trước khi tạo HttpOnly admin session.

Browser flow:

```text
/admin-auth.html
  -> /auth/google/start
  -> Google OAuth
  -> /auth/google/callback
  -> lana_admin_session (HttpOnly)
  -> /projects hoặc project đang mở
```

Không lưu Google access/refresh token. Lana chỉ dùng ID token đã xác minh để xác thực danh tính rồi tạo session nội bộ.

### Reverse proxy / TLS boundary

`src/http-server.js` lắng nghe HTTP nội bộ, trong khi production dùng `PUBLIC_BASE_URL=https://...`. Vì vậy TLS phải kết thúc ở reverse proxy/load balancer phía trước Node.

Khi Google OAuth được bật trên production HTTPS, cần cấu hình rõ IP/subnet của **chính reverse proxy được tin cậy**:

```env
OAUTH_TRUSTED_PROXY_CIDRS=127.0.0.1/8,::1/128
```

Ví dụ trên chỉ đúng khi Nginx/Caddy kết nối tới Node từ loopback. Nếu proxy chạy trong Docker/VPC/host khác, dùng đúng IP hoặc CIDR thực tế của proxy đó; không dùng dải rộng chỉ để “cho chạy”.

Lana truyền danh sách này cho Express `trust proxy`. Nhờ đó `req.ip` chỉ dùng `X-Forwarded-For` khi request đi qua proxy nằm trong allowlist; request trực tiếp từ địa chỉ không được trust không thể tự khai báo client IP bằng forwarded header.

Reverse proxy cuối cùng phải **overwrite/normalize** `X-Forwarded-For`, `X-Forwarded-Host` và `X-Forwarded-Proto` thay vì nối tiếp giá trị tùy ý do client gửi. Nếu chưa biết chính xác topology/proxy source CIDR thì không bật OAuth production cho tới khi xác định được boundary này.

## 2. OAuth cho MCP

MCP endpoint vẫn là:

```text
https://content.lanadesign.tech/mcp
```

OAuth discovery:

```text
https://content.lanadesign.tech/.well-known/oauth-protected-resource
https://content.lanadesign.tech/.well-known/oauth-authorization-server
```

Authorization server endpoints:

```text
POST /oauth/register
GET  /oauth/authorize
POST /oauth/authorize
POST /oauth/token
```

Flow:

```text
MCP client
  -> Protected Resource Metadata
  -> Authorization Server Metadata
  -> Dynamic Client Registration
  -> /oauth/authorize?resource=https://content.lanadesign.tech/mcp&code_challenge=...
  -> Google login nếu browser chưa có Lana admin session
  -> màn hình xác nhận "Kết nối Lana MCP"
  -> authorization code
  -> /oauth/token + code_verifier
  -> opaque Bearer access token + refresh token
  -> Authorization: Bearer <access_token> trên mọi request /mcp
```

Lana bắt buộc PKCE `S256`. Access token được ràng buộc với resource chính xác `PUBLIC_BASE_URL/mcp`; token dành cho resource khác không dùng được với MCP.

`/oauth/token` có hai lớp giới hạn: pre-auth theo `req.ip` đã được xác định qua trusted-proxy boundary, và giới hạn theo client chỉ sau khi authorization code/refresh token chứng minh client/resource hợp lệ. Vì `client_id` là public identifier, request giả chỉ biết `client_id` không được phép đốt quota client hợp lệ.

Nếu admin session hết hạn sau khi màn hình consent đã được tạo nhưng trước lúc bấm Cho phép/Hủy, Lana dừng request với trang báo phiên đã hết hạn và yêu cầu MCP client bắt đầu lại OAuth flow. Lana không cố tái tạo một authorization request thiếu tham số từ POST cũ.

## 3. Token lifetime

Mặc định:

```env
OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
OAUTH_AUTHORIZATION_CODE_TTL_SECONDS=300
OAUTH_LOGIN_STATE_TTL_SECONDS=600
OAUTH_CONSENT_TTL_SECONDS=300
```

Authorization code và consent token chỉ dùng một lần. Refresh token được rotate mỗi lần refresh.

## 4. Chuyển ChatGPT MCP từ API key sang OAuth

Sau khi deploy và cấu hình Google OAuth:

1. Xóa/reconnect MCP cũ nếu connection đang lưu API key.
2. Dùng lại URL `https://content.lanadesign.tech/mcp` mà không nhập API key.
3. MCP client nhận `401` với `WWW-Authenticate` trỏ đến Protected Resource Metadata.
4. Client mở browser OAuth flow.
5. Đăng nhập Google bằng tài khoản nằm trong allowlist.
6. Xác nhận cấp scope `mcp`.
7. Client tự dùng và refresh Bearer token.

## 5. Legacy REST API key

Có thể tạm giữ trong thời gian migration:

```env
API_KEY=...
```

nhưng chỉ cho REST/server-to-server qua:

```http
X-API-Key: ...
```

`Authorization: Bearer` được dành cho OAuth, và `/mcp` không chấp nhận API key. Sau khi mọi automation REST đã chuyển sang cơ chế khác, có thể xóa hẳn `API_KEY`/`API_KEYS` khỏi production.