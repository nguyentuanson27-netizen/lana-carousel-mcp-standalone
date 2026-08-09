# Lana Carousel MCP Standalone

Dịch vụ MCP độc lập giúp ChatGPT tạo và quản lý Carousel và Video Analysis theo quy trình:

**Duyệt nội dung → Duyệt ảnh/script → Chỉnh sửa → Render → Tải kết quả**

Production:

- MCP endpoint: `https://content.lanadesign.tech/mcp`
- Project dashboard: `https://content.lanadesign.tech/projects`
- Video Analysis Studio: `https://content.lanadesign.tech/video-studio`
- Health check: `https://content.lanadesign.tech/health`

## Tính năng chính

- Tạo dự án, slide và Video Analysis project bằng MCP.
- Tự động hết hạn dự án sau 14 ngày; hỗ trợ gia hạn, clone và xóa thủ công.
- Nhập ảnh/video từ URL với kiểm tra SSRF, redirect, MIME, magic bytes, dung lượng và timeout.
- Tối đa 10 ảnh ứng viên cho mỗi slide, được bảo vệ bằng invariant SQLite khi có request đồng thời.
- Duyệt một ảnh hoặc ghép nhiều ảnh dạng lưới; crop, zoom, lật ảnh, chọn kiểu vừa khung, filter và tùy chỉnh khung.
- Sửa ảnh trực tiếp trên khung xem trước: kéo để đổi vị trí, Ctrl/Cmd + lăn chuột để phóng to/thu nhỏ.
- Ảnh tải về khớp ảnh preview theo hợp đồng ghi trong [docs/preview-render-parity.md](docs/preview-render-parity.md).
- Nhiều lớp chữ kéo thả, rich text và animation trong MP4.
- Font đi kèm repo (`public/fonts/`), dùng chung cho trình duyệt và renderer nên chữ trong ảnh tải về đúng font đã chọn.
- Video 9:16, 1:1 và 16:9; TTS, phụ đề và nhạc nền.
- Audio upload có lifecycle `STAGED → REFERENCED`; file chưa được lưu vào settings/version bị xóa sau grace period.
- Giới hạn số file và tổng byte audio theo project để bảo vệ dung lượng ổ đĩa.
- Dashboard, widget và Video Analysis Studio dùng browser session HttpOnly.
- Media thật được bảo vệ theo project grant hoặc signed URL ngắn hạn cho render worker.
- Quota mutation/heavy gắn với API principal ổn định.

## Yêu cầu

- **Node.js 22 trở lên**.
- Domain HTTPS công khai khi kết nối từ ChatGPT.
- API key production dài tối thiểu 32 ký tự.
- SQLite và các thư mục dữ liệu được tạo tự động.

## Cài đặt

```bash
cp .env.example .env
openssl rand -hex 32
# Gán kết quả vào API_KEY trong .env
npm install
npm run check
npm start
```

HTTP server mặc định:

```text
http://localhost:8787
```

Chạy MCP qua stdio:

```bash
npm run mcp
```

Chạy bằng Docker:

```bash
docker compose up -d --build
```

Chạy production bằng PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Biến môi trường quan trọng

| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `NODE_ENV` | development | Đặt `production` để bật bắt buộc xác thực |
| `PORT` | `8787` | Cổng HTTP |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | Origin public |
| `DATABASE_PATH` | `./data/lana-carousel.sqlite` | Đường dẫn SQLite |
| `ASSET_DIRECTORY` | `./data/assets` | Thư mục ảnh Carousel |
| `API_KEY` / `API_KEYS` | trống | API key hoặc danh sách key production |
| `API_RATE_LIMIT_PER_MINUTE` | `120` | Rate limit mỗi principal |
| `API_DAILY_MUTATION_QUOTA` | `500` | Quota mutation mỗi ngày |
| `API_DAILY_HEAVY_QUOTA` | `60` | Quota tác vụ nặng mỗi ngày |
| `PROJECT_ACCESS_TOKEN_TTL_SECONDS` | `300` | TTL one-time project link |
| `PROJECT_SESSION_TTL_SECONDS` | `3600` | TTL browser project session |
| `MAX_IMAGE_BYTES` | `10485760` | Dung lượng ảnh tối đa |
| `MAX_REMOTE_AUDIO_BYTES` | `26214400` | Dung lượng mỗi audio tối đa |
| `PROJECT_AUDIO_STAGED_TTL_SECONDS` | `3600` | Thời gian giữ upload audio chưa được lưu |
| `PROJECT_AUDIO_MAX_FILES` | `20` | Tổng số file audio tối đa cho một project |
| `PROJECT_AUDIO_MAX_BYTES` | `262144000` | Tổng dung lượng audio tối đa cho một project |
| `MAX_REMOTE_VIDEO_BYTES` | `524288000` | Dung lượng video tối đa |

## Xác thực production

Production không cho phép truy cập ẩn danh vào `/api/*`, `/mcp` hoặc media được quản lý.

- MCP chấp nhận `Authorization: Bearer <API_KEY>` hoặc `X-API-Key: <API_KEY>`.
- Dashboard đổi API key thành admin session HttpOnly.
- Link project do MCP phát là token dùng một lần, sau đó đổi thành resource session HttpOnly.
- Không đưa API key dài hạn vào URL, localStorage hoặc cookie JavaScript.

## Kết nối ChatGPT

Trong ChatGPT web:

1. Mở **Settings → Apps → Advanced Settings**.
2. Bật **Developer mode**.
3. Chọn **Create App**.
4. Đặt tên, ví dụ `Lana Carousel App 2`.
5. Nhập MCP endpoint:

   ```text
   https://content.lanadesign.tech/mcp
   ```

6. Cấu hình authentication bằng API key/Bearer token tương ứng với `API_KEY` trên server.
7. **Không chọn `No authentication` cho production.** Chỉ dùng chế độ không xác thực khi chạy local development và server không chứa dữ liệu thật.
8. Bấm **Scan Tools** rồi **Create**.
9. Chọn App trong cuộc trò chuyện trước khi gửi prompt.

Tài liệu OpenAI: [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta).

## Prompt khuyến nghị

```text
Hãy sử dụng Lana Carousel App 2 để tạo carousel:

- Chủ đề: Top 5 thương hiệu áo dài nổi bật năm 2026.
- Tổng cộng 6 slide: 1 slide mở đầu và 5 slide thương hiệu.
- Mỗi chủ đề chỉ tạo một slide.
- Không tạo slide riêng cho từng ảnh.
- Mỗi slide nhập 3–5 ảnh ứng viên bằng add_image_candidates.
- Không tự duyệt nội dung, không tự duyệt ảnh và không render.
- Sau khi hoàn thành, gọi get_project_link và gửi link dự án.
```

## Công cụ MCP

Nhóm dự án:

- `create_project`, `get_project`, `get_project_link`, `list_projects`
- `clone_project`, `extend_project`, `delete_project`
- `list_project_versions`, `restore_project_version`

Nhóm slide và ảnh:

- `add_slide`
- `import_asset_from_url`, `add_image_candidate`, `add_image_candidates`
- `approve_slide_images`, `update_slide_content`, `update_slide_design`
- `approve_content`, `update_brand_kit`

Nhóm render:

- `render_project`, `get_render_status`
- Các tool Video Analysis project, script, source và render.

## Quy tắc sử dụng

- Slide đại diện cho chủ đề nội dung, không đại diện cho từng ảnh.
- Ảnh thay thế phải được thêm vào slide hiện có.
- Chỉ render khi nội dung và ảnh/script đã được duyệt.
- Sau khi cập nhật schema MCP, chạy lại **Scan Tools/Refresh Actions** trong ChatGPT.

## Dữ liệu không được commit

`.gitignore` loại trừ `.env`, `node_modules/`, `data/`, SQLite, log và output build.

Không commit SSH key, token, database production hoặc thư mục asset.
