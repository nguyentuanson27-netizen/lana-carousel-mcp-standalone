# Lana Carousel MCP Standalone

Dịch vụ MCP độc lập giúp ChatGPT tạo và quản lý carousel ảnh theo quy trình:

**Duyệt nội dung → Duyệt ảnh → Sửa ảnh → Render và tải ZIP**

Production:

- MCP endpoint: `https://content.lanadesign.tech/mcp`
- Project dashboard: `https://content.lanadesign.tech/projects`
- Health check: `https://content.lanadesign.tech/health`

## Tính năng

- Tạo dự án và slide nội dung bằng MCP.
- Tự động xóa dự án sau 14 ngày; hỗ trợ gia hạn, nhân bản và xóa thủ công.
- Nhập ảnh từ URL HTTPS, theo redirect và gửi User-Agent.
- Kiểm tra SSRF, MIME, magic bytes, dung lượng và timeout.
- Chuẩn hóa JPG, PNG và WebP thành WebP bằng Sharp.
- Lưu tối đa 10 ảnh ứng viên cho mỗi slide.
- Duyệt một ảnh hoặc ghép nhiều ảnh dạng lưới.
- Crop ảnh 9:16, zoom và chọn trọng tâm.
- Chỉnh độ sáng, tương phản, bão hòa, đen trắng và làm mờ ảnh.
- Tùy chỉnh khung: màu viền, độ dày, khoảng cách mép, độ mờ và bo góc.
- Preview dọc 9:16 cỡ lớn, responsive theo màn hình và khớp tỷ lệ render 1080×1920.
- Nhiều lớp chữ có thể kéo thả trực quan.
- Chọn font, cỡ chữ, màu, vị trí, căn lề, độ trong suốt và góc xoay.
- Bôi đen từng đoạn trong cùng một ô chữ để đặt cỡ chữ riêng.
- Hộp chữ riêng cho từng lớp: nền, độ mờ, viền, bo góc, chiều rộng và khoảng đệm.
- Các nhóm Kiểu chữ, Hộp chữ và Chỉnh ảnh/khung có thể thu gọn, giữ nguyên trạng thái khi giao diện cập nhật.
- Brand Kit và áp dụng thiết kế cho toàn bộ slide.
- Hoàn tác/làm lại trong trình sửa.
- Render nền, theo dõi tiến độ và tải bộ ảnh ZIP.
- Lịch sử phiên bản dự án.
- Dashboard tìm kiếm và quản lý dự án.

## Yêu cầu

- Node.js 20 trở lên.
- Một domain HTTPS công khai nếu kết nối từ ChatGPT.
- SQLite được tạo tự động.

## Cài đặt

```bash
cp .env.example .env
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

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `PORT` | `8787` | Cổng HTTP |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | Domain public |
| `DATABASE_PATH` | `./data/lana-carousel.sqlite` | Đường dẫn SQLite |
| `ASSET_DIRECTORY` | `./data/assets` | Thư mục lưu ảnh |
| `MAX_IMAGE_BYTES` | `10485760` | Dung lượng ảnh tối đa |
| `IMAGE_TIMEOUT_MS` | `15000` | Timeout tải ảnh |
| `MAX_REDIRECTS` | `3` | Số redirect tối đa |

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

6. Chọn `No authentication` nếu triển khai nội bộ không dùng xác thực.
7. Bấm **Scan Tools** rồi **Create**.
8. Chọn App trong cuộc trò chuyện trước khi gửi prompt.

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

Nhóm tạo và đọc dự án:

- `create_project`
- `add_slide`
- `get_project`
- `get_project_link`
- `list_projects`

Nhóm ảnh:

- `import_asset_from_url`
- `add_image_candidate`
- `add_image_candidates`
- `approve_slide_images`

Nhóm nội dung và thiết kế:

- `update_slide_content`
- `update_slide_design`
- `approve_content`
- `update_brand_kit`

Nhóm render:

- `render_project`
- `get_render_status`

Nhóm quản lý:

- `clone_project`
- `extend_project`
- `delete_project`
- `list_project_versions`
- `restore_project_version`

## Quy tắc sử dụng quan trọng

- Slide đại diện cho **chủ đề nội dung**, không đại diện cho từng ảnh.
- Ảnh thay thế phải được gắn vào slide hiện có bằng `add_image_candidate` hoặc `add_image_candidates`.
- Nên dùng 3–5 ảnh ứng viên cho mỗi slide.
- Chỉ render sau khi toàn bộ nội dung và ảnh đã được duyệt.
- Sau khi cập nhật schema công cụ MCP, cần chạy lại **Scan Tools/Refresh Actions** trong ChatGPT.

## Dữ liệu không được commit

`.gitignore` loại trừ:

- `.env`
- `node_modules/`
- `data/`
- database SQLite
- log và output build

Không commit SSH key, token, database production hoặc thư mục asset.
