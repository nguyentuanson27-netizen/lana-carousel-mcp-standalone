# Social Publisher MVP

Lana Content Studio có bước 6 **Đăng mạng xã hội** để gửi output đã duyệt lên Facebook, Instagram và TikTok.

## Phạm vi MVP

| Nền tảng | Kết nối | Carousel | Video | Chế độ |
| --- | --- | --- | --- | --- |
| Facebook Page | credential nội bộ trên server | multi-photo post | Reel | publish trực tiếp |
| Instagram Professional | Instagram Login | Carousel | Reel | publish trực tiếp |
| TikTok | TikTok OAuth | Photo Mode draft | video draft | Upload Draft |

Thiết kế này cố ý **không dùng Facebook Login for Business**. Facebook Page của Lana được quản lý như một integration nội bộ; Instagram kết nối độc lập bằng Instagram Login; TikTok giữ flow OAuth hiện tại.

## Bảo mật

- Các endpoint quản lý tài khoản, tạo post, retry và xem lịch sử chỉ chấp nhận `admin-session` hoặc API key. Link dự án/MCP resource session không có quyền publish.
- Access token và refresh token được mã hóa AES-256-GCM trước khi lưu SQLite.
- `SOCIAL_TOKEN_ENCRYPTION_KEY` phải được giữ ổn định. Đổi/mất key sẽ làm credential đã lưu không giải mã được.
- Facebook Page token có nguồn cấu hình duy nhất từ environment ở server, không trả về browser. Account Facebook đang khớp credential env hiện tại được đánh dấu managed và không thể disconnect từ UI/API.
- Facebook account do env tạo chỉ được publish khi Page ID đó vẫn khớp cấu hình server hiện tại. Nếu env bị xóa hoặc đổi sang Page khác, row cũ trở thành cleanup-only: không auto-select, không tạo post mới và queued delivery cũ sẽ fail-closed trước provider call.
- Provider không truy cập trực tiếp API media private của Lana. Social Publisher tạo URL HMAC có TTL cho từng ảnh/MP4.
- URL Social media mặc định hết hạn sau 6 giờ (`SOCIAL_MEDIA_URL_TTL_SECONDS=21600`).

Tạo ba secret độc lập:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

```env
SOCIAL_TOKEN_ENCRYPTION_KEY=...
SOCIAL_OAUTH_STATE_SECRET=...
SOCIAL_MEDIA_SIGNING_SECRET=...
```

## Facebook Page nội bộ

Không có nút OAuth Facebook. Cấu hình trực tiếp trên server:

```env
META_GRAPH_API_VERSION=v23.0
FACEBOOK_PAGE_ID=...
FACEBOOK_PAGE_NAME=La.na Design
FACEBOOK_PAGE_ACCESS_TOKEN=...
```

`FACEBOOK_PAGE_ACCESS_TOKEN` phải là Page Access Token có quyền publish lên đúng Page (`pages_manage_posts`). Sau khi restart, Lana upsert một `social_account` Facebook và mã hóa token bằng cùng credential store hiện có. Nếu đổi token trong `.env` nhưng giữ nguyên `FACEBOOK_PAGE_ID`, restart sẽ cập nhật credential của cùng Page thay vì tạo account trùng.

Nếu `FACEBOOK_PAGE_ID` đổi sang Page khác, Lana provision Page mới và giữ row Page cũ chỉ để cleanup/history. Nếu Facebook env bị xóa hoàn toàn, row cũ cũng chuyển sang cleanup-only. Trong cả hai trường hợp, stale row hiển thị **Cần cấu hình lại**, checkbox publish bị disable, API tạo post trả `SOCIAL_FACEBOOK_CREDENTIAL_STALE`, queued delivery cũ fail trước khi gọi Facebook provider, nhưng nút **Ngắt** vẫn hoạt động để dọn row cũ. Lana không tự xóa row khi env thay đổi để tránh làm mất lịch sử/account binding ngoài ý muốn.

## Instagram Login

Instagram dùng **Instagram API with Instagram Login**, không cần Facebook Page liên kết.

Cấu hình:

```env
INSTAGRAM_GRAPH_API_VERSION=v23.0
INSTAGRAM_APP_ID=...
INSTAGRAM_APP_SECRET=...
```

Redirect URI production:

```text
https://content.lanadesign.tech/social/oauth/instagram/callback
```

Lana yêu cầu đúng hai scope cần cho MVP publish:

```text
instagram_business_basic,instagram_business_content_publish
```

Flow:

```text
Lana -> www.instagram.com/oauth/authorize
     -> /social/oauth/instagram/callback
     -> đổi code lấy Instagram User access token
     -> đổi sang long-lived token
     -> mã hóa token trong social_accounts
     -> publish qua graph.instagram.com
```

Instagram account phải là Professional account (Business hoặc Creator). Với use case nội bộ, cấu hình Meta app theo Standard Access cho account mà chủ app sở hữu/quản lý và đã thêm vào App Dashboard. Nếu sau này app phục vụ Instagram account của bên thứ ba, phải đánh giá lại Advanced Access/App Review.

Nếu database còn Instagram account được tạo bởi flow Facebook Login cũ, Lana sẽ hiển thị **Cần kết nối lại**, không auto-select và từ chối publish bằng token cũ. Bấm **Ngắt**, sau đó kết nối lại bằng nút **+ Instagram** để lấy Instagram User token đúng loại.

Lana refresh long-lived Instagram token khi token còn dưới 7 ngày trước lúc publish. Nếu refresh thất bại, delivery fail rõ ràng thay vì âm thầm đăng bằng credential không hợp lệ.

## TikTok

Không thay đổi flow hiện tại:

```env
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
```

OAuth redirect URI:

```text
https://content.lanadesign.tech/social/oauth/tiktok/callback
```

Scopes:

```text
user.info.basic,video.upload
```

TikTok Upload Draft dùng `PULL_FROM_URL`. Trong TikTok Developer Portal cần verify domain/URL prefix chứa media Lana cung cấp, tối thiểu:

```text
https://content.lanadesign.tech/social-media/
```

Sau khi delivery chuyển `AWAITING_USER`, người dùng mở TikTok để hoàn tất bài đăng. Nút **Kiểm tra** gọi Publish Status API.

## Điều kiện media

Carousel chỉ được publish khi content và image đều `APPROVED`, từng slide có ảnh duyệt và từng slide đã **Lưu thiết kế**. Lana render lại final slide bằng `renderSlideSnapshot()` khi provider tải signed URL. MVP giới hạn tối đa 10 ảnh/lượt publish.

Video phải có `video_render_job` trạng thái `READY`; Social Publisher dùng MP4 READY mới nhất.

## Delivery model và retry

Một lần **Duyệt & đăng ngay** tạo một `social_post`, sau đó một `social_delivery` riêng cho từng account:

```text
Post
├── Facebook  -> PUBLISHED
├── Instagram -> FAILED
└── TikTok    -> AWAITING_USER
```

Retry chỉ đưa delivery `FAILED` về queue; delivery đã thành công không gửi lại. Các trạng thái chính: `QUEUED`, `PROCESSING`, `PUBLISHED`, `AWAITING_USER`, `FAILED`. Worker kiểm tra queue mỗi 15 giây và queue được lưu SQLite.

## Environment đầy đủ

```env
SOCIAL_TOKEN_ENCRYPTION_KEY=
SOCIAL_OAUTH_STATE_SECRET=
SOCIAL_MEDIA_SIGNING_SECRET=
SOCIAL_MEDIA_URL_TTL_SECONDS=21600
SOCIAL_REQUEST_TIMEOUT_MS=30000
SOCIAL_INSTAGRAM_PROCESSING_TIMEOUT_MS=120000

META_GRAPH_API_VERSION=v23.0
FACEBOOK_PAGE_ID=
FACEBOOK_PAGE_NAME=La.na Design
FACEBOOK_PAGE_ACCESS_TOKEN=

INSTAGRAM_GRAPH_API_VERSION=v23.0
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

`PUBLIC_BASE_URL` phải là HTTPS URL mà Instagram/TikTok và provider media có thể truy cập từ Internet.

## Verification sau deploy

CI kiểm tra contract, persistence, provider routing và regression nhưng không gọi credential thật của Meta/TikTok. Sau deploy cần smoke-test tối thiểu: Facebook Page đăng một post thử, Instagram Login hoàn tất callback rồi publish một media thử, TikTok reconnect/publish draft như flow cũ. Nếu Meta thay token endpoint hoặc yêu cầu mới, lỗi provider phải được xử lý trước khi coi rollout Social hoàn tất.

## Ngoài MVP

- Facebook OAuth/public multi-tenant onboarding.
- Instagram accounts của khách hàng bên ngoài cần Advanced Access/App Review.
- Scheduler / Social Calendar.
- TikTok Direct Post (`video.publish`).
- Analytics 24h/72h.
- AI tối ưu caption/thời điểm đăng.
- YouTube Shorts.
