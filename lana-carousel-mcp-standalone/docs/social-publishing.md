# Social Publisher MVP

Lana Content Studio có bước 6 **Đăng mạng xã hội** để gửi output đã duyệt lên Facebook, Instagram và TikTok.

## Phạm vi MVP

| Nền tảng | Carousel | Video | Chế độ |
| --- | --- | --- | --- |
| Facebook Page | multi-photo post | Reel | publish trực tiếp |
| Instagram Professional | Carousel | Reel | publish trực tiếp |
| TikTok | Photo Mode draft | video draft | Upload Draft, người dùng hoàn tất trong TikTok |

TikTok Direct Post chưa bật trong MVP. Cách này cho phép triển khai trước khi app hoàn tất quy trình audit của TikTok và vẫn để người dùng chọn nhạc/sticker/chỉnh sửa cuối trong ứng dụng TikTok.

## Bảo mật

- Các endpoint quản lý tài khoản, tạo post, retry và xem lịch sử chỉ chấp nhận `admin-session` hoặc API key. Link dự án/MCP resource session không có quyền publish.
- Access token và refresh token được mã hóa AES-256-GCM trước khi lưu SQLite.
- `SOCIAL_TOKEN_ENCRYPTION_KEY` phải được giữ ổn định. Đổi/mất key sẽ làm các credential đã lưu không giải mã được; khi đó cần kết nối lại tài khoản.
- Provider không truy cập trực tiếp các API media private của Lana. Social Publisher tạo URL HMAC có thời hạn cho từng ảnh/MP4.
- URL Social media mặc định hết hạn sau 6 giờ (`SOCIAL_MEDIA_URL_TTL_SECONDS=21600`).

Tạo ba secret độc lập:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Gán lần lượt cho:

```env
SOCIAL_TOKEN_ENCRYPTION_KEY=...
SOCIAL_OAUTH_STATE_SECRET=...
SOCIAL_MEDIA_SIGNING_SECRET=...
```

## Meta: Facebook + Instagram

Cấu hình:

```env
META_GRAPH_API_VERSION=v23.0
META_APP_ID=...
META_APP_SECRET=...
```

OAuth callback URI:

```text
https://content.lanadesign.tech/social/oauth/meta/callback
```

Các quyền được yêu cầu trong MVP:

- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_posts`
- `instagram_basic`
- `instagram_content_publish`

Facebook Login trả danh sách Page mà user quản lý. Lana lưu Page access token cho Facebook và dùng cùng Page token cho Instagram Professional account được liên kết với Page đó.

### Điều kiện Instagram

Instagram account phải là Professional account phù hợp với API publish và được liên kết với Facebook Page mà user có quyền cần thiết.

## TikTok

Cấu hình:

```env
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
```

OAuth redirect URI:

```text
https://content.lanadesign.tech/social/oauth/tiktok/callback
```

MVP yêu cầu scopes:

```text
user.info.basic,video.upload
```

TikTok Upload Draft dùng `PULL_FROM_URL`. Trong TikTok Developer Portal cần xác minh domain/URL prefix chứa media mà Lana cung cấp, tối thiểu:

```text
https://content.lanadesign.tech/social-media/
```

Sau khi delivery chuyển thành `AWAITING_USER`, TikTok đã nhận draft; người dùng mở TikTok để hoàn tất bài đăng. Nút **Kiểm tra** trong Lana gọi Publish Status API để cập nhật trạng thái khi TikTok có kết quả.

## Điều kiện media

### Carousel

Chỉ được tạo post Carousel khi:

- content status là `APPROVED`;
- image status là `APPROVED`;
- từng slide có ảnh đã duyệt;
- từng slide đã **Lưu thiết kế**.

Lana render lại final slide bằng `renderSlideSnapshot()` khi provider tải signed URL, vì vậy output đăng lên khớp thiết kế cuối chứ không phải raw asset.

MVP giới hạn tối đa 10 ảnh cho một lượt publish để tương thích chung giữa các kênh.

### Video

Phải có một `video_render_job` ở trạng thái `READY`. Social Publisher dùng MP4 READY mới nhất của project.

## Delivery model và retry

Một lần bấm **Duyệt & đăng ngay** tạo một `social_post`, sau đó tạo một `social_delivery` riêng cho từng account đã chọn.

Ví dụ:

```text
Post
├── Facebook  -> PUBLISHED
├── Instagram -> FAILED
└── TikTok    -> AWAITING_USER
```

Retry chỉ đưa delivery `FAILED` trở lại queue. Delivery đã thành công không được gửi lại, tránh đăng trùng bài.

Các trạng thái chính:

- `QUEUED`
- `PROCESSING`
- `PUBLISHED`
- `AWAITING_USER` (TikTok draft)
- `FAILED`

Worker nội bộ kiểm tra queue mỗi 15 giây. Queue được lưu SQLite nên không mất khi process Node restart.

## Environment đầy đủ

```env
SOCIAL_TOKEN_ENCRYPTION_KEY=
SOCIAL_OAUTH_STATE_SECRET=
SOCIAL_MEDIA_SIGNING_SECRET=
SOCIAL_MEDIA_URL_TTL_SECONDS=21600
SOCIAL_REQUEST_TIMEOUT_MS=30000
SOCIAL_INSTAGRAM_PROCESSING_TIMEOUT_MS=120000

META_GRAPH_API_VERSION=v23.0
META_APP_ID=
META_APP_SECRET=

TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
```

`PUBLIC_BASE_URL` phải là HTTPS URL mà Meta/TikTok có thể truy cập từ Internet.

## Những phần chưa thuộc MVP

- Scheduler / Social Calendar.
- TikTok Direct Post (`video.publish`).
- Analytics 24h/72h.
- AI tối ưu caption/thời điểm đăng tự động.
- YouTube Shorts.

Các phần này có thể xây trên `social_accounts`, `social_posts`, `social_deliveries` và `social_publish_events` mà không đổi workflow publish hiện tại.
