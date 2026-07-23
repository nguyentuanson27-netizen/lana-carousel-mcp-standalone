# Lana Carousel MCP Standalone

Dịch vụ độc lập, không phụ thuộc repo Lana Carousel App hiện tại. Dịch vụ tự tạo:

- SQLite database;
- bảng `projects`, `slides`, `assets`;
- thư mục lưu ảnh;
- REST API;
- MCP server qua stdio;
- tool `import_asset_from_url`.

## Tính năng

- Tạo project và slide.
- Tải ảnh thật từ URL HTTPS.
- Chống SSRF, localhost, private IP, link-local và redirect không an toàn.
- Timeout, giới hạn 10 MB, tối đa 3 redirect.
- Kiểm tra Content-Type và magic bytes.
- Chuẩn hóa ảnh thành WebP bằng Sharp.
- Chống trùng bằng SHA-256.
- Lưu metadata nguồn ảnh.
- Gắn ảnh vào `selected_asset_id` của slide.
- Phục vụ file ảnh tại `/assets/...`.

## Cài trực tiếp

```bash
cp .env.example .env
npm install
npm run check
npm start
```

HTTP server mặc định chạy tại:

```text
http://localhost:8787
```

Chạy MCP stdio:

```bash
npm run mcp
```

## Chạy bằng Docker

```bash
docker compose up -d --build
```

## Cấu hình MCP client

Ví dụ cấu hình local:

```json
{
  "mcpServers": {
    "lana-carousel": {
      "command": "node",
      "args": ["/absolute/path/lana-carousel-mcp-standalone/src/mcp-server.js"],
      "env": {
        "PUBLIC_BASE_URL": "https://content.example.com",
        "DATABASE_PATH": "/absolute/path/data/lana-carousel.sqlite",
        "ASSET_DIRECTORY": "/absolute/path/data/assets"
      }
    }
  }
}
```

Lưu ý: MCP chạy bằng stdio chỉ tạo và lưu dữ liệu. Để URL ảnh public hoạt động, cần đồng thời chạy HTTP server hoặc cấu hình Nginx phục vụ thư mục asset.

## REST API

### Tạo project

```bash
curl -X POST http://localhost:8787/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"title":"Top 5 áo dài Tết 2025","topic":"Áo dài độc đáo"}'
```

### Thêm slide

```bash
curl -X POST http://localhost:8787/api/projects/PROJECT_ID/slides \
  -H 'Content-Type: application/json' \
  -d '{
    "position":1,
    "subject":"Võ Việt Chung – Bức tranh mùa xuân",
    "headline":"TOP 1 — Tranh Đông Hồ bước lên tà áo dài",
    "body":"Mô tả ngắn cho slide."
  }'
```

### Nhập ảnh từ URL

```bash
curl -X POST http://localhost:8787/api/projects/PROJECT_ID/slides/SLIDE_ID/assets/import-url \
  -H 'Content-Type: application/json' \
  -d '{
    "image_url":"https://example.com/exact-image.jpg",
    "source_page_url":"https://example.com/article",
    "source_title":"Tên bài viết",
    "source_publisher":"Tên báo",
    "source_type":"magazine",
    "alt_text":"Ảnh thật thuộc đúng bộ sưu tập",
    "force_replace":false
  }'
```

### Kiểm tra project

```bash
curl http://localhost:8787/api/projects/PROJECT_ID
```

Kết quả đúng khi slide có:

```json
{
  "selectedAssetId": "uuid-cua-asset"
}
```

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---:|---|
| `PORT` | `8787` | Cổng HTTP |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | Domain public của ảnh |
| `DATABASE_PATH` | `./data/lana-carousel.sqlite` | SQLite database |
| `ASSET_DIRECTORY` | `./data/assets` | Thư mục ảnh |
| `MAX_IMAGE_BYTES` | `10485760` | Dung lượng ảnh tối đa |
| `IMAGE_TIMEOUT_MS` | `15000` | Timeout tải ảnh |
| `MAX_REDIRECTS` | `3` | Số redirect tối đa |

## Triển khai VPS

1. Trỏ domain, ví dụ `content.example.com`, vào VPS.
2. Đặt `PUBLIC_BASE_URL=https://content.example.com`.
3. Chạy Docker Compose.
4. Reverse proxy Nginx vào `127.0.0.1:8787`.
5. Bật HTTPS.
6. Khai báo MCP client chạy `src/mcp-server.js`.

## Giới hạn

- Chỉ tải ảnh public HTTPS.
- Không bypass CAPTCHA, đăng nhập, paywall hoặc anti-bot.
- Một số báo chặn hotlink; khi đó cần dùng ảnh từ website chính thức hoặc upload thủ công.
- Dự án này chưa render thiết kế carousel; nó quản lý nội dung và asset ảnh. Có thể thêm renderer HTML/Canvas ở bước tiếp theo.
