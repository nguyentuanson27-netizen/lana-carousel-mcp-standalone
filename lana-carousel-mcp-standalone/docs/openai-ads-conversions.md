# OpenAI Ads Pixel + Conversions API

Tích hợp này tách rõ hai kênh đo lường:

- **Measurement Pixel** chạy trong browser trên website.
- **Conversions API (CAPI)** chỉ chạy server-side và giữ CAPI key trong biến môi trường.
- Nếu cùng một conversion được gửi bởi Pixel và CAPI, dùng cùng một event ID để OpenAI khử trùng lặp.

Tài liệu chính thức:

- https://developers.openai.com/ads/measurement-pixel
- https://developers.openai.com/ads/conversions-api
- https://developers.openai.com/ads/supported-events

## 1. Cấu hình server

Đặt trong `.env`:

```bash
OPENAI_ADS_PIXEL_ID=<pixel-id>
OPENAI_CONVERSIONS_API_KEY=<conversions-api-key>
OPENAI_ADS_REQUEST_TIMEOUT_MS=10000
```

Không đưa `OPENAI_CONVERSIONS_API_KEY` vào JavaScript browser, HTML, Git hoặc log.

## 2. Cài Pixel trên storefront

File helper được host tại:

```text
https://content.lanadesign.tech/openai-ads-pixel.js
```

Ví dụ:

```html
<script src="https://content.lanadesign.tech/openai-ads-pixel.js"></script>
<script>
  LanaOpenAIAds.init({
    pixelId: "<PIXEL-ID>",
    consent: true,
    debug: false
  });
</script>
```

Nếu website cần consent trước khi đo lường, khởi tạo với `consent: false`, sau đó gọi:

```js
LanaOpenAIAds.setConsent(true);
```

## 3. Gửi purchase bằng Pixel

`amount` dùng integer theo ISO 4217 minor unit. Với VND, gửi số nguyên VND.

```js
const eventId = "order_" + orderId;

LanaOpenAIAds.measure(
  "order_created",
  {
    type: "contents",
    amount: totalVnd,
    currency: "VND",
    contents: items.map(item => ({
      id: item.sku,
      name: item.name,
      content_type: "product",
      quantity: item.quantity
    }))
  },
  { eventId }
);

const attribution = LanaOpenAIAds.getAttribution();
// Gửi eventId + attribution về backend đặt hàng để server gửi cùng event qua CAPI.
```

## 4. Gửi cùng event qua CAPI

Backend storefront gọi endpoint server-to-server:

```http
POST https://content.lanadesign.tech/api/openai-ads/events
Authorization: Bearer <existing-server-api-key>
Content-Type: application/json
```

Payload:

```json
{
  "validate_only": false,
  "events": [
    {
      "id": "order_12345",
      "type": "order_created",
      "source_url": "https://www.lanadesign.vn/checkout/success",
      "oppref": "<__oppref-cookie-if-available>",
      "user": {
        "obref": "<__obref-cookie-if-available>",
        "email": "customer@example.com",
        "country": "VN",
        "user_agent": "<browser-user-agent>"
      },
      "data": {
        "type": "contents",
        "amount": 1599000,
        "currency": "VND",
        "contents": [
          {
            "id": "SKU-123",
            "name": "Áo dài Lana",
            "content_type": "product",
            "quantity": 1
          }
        ]
      }
    }
  ]
}
```

Server tự chuẩn hóa và SHA-256 email trước khi gửi tới OpenAI. Không tự động lấy IP của request vì request tới endpoint này có thể đến từ backend storefront, không phải browser của khách.

## 5. Dedup Pixel + CAPI

Đối với cùng một purchase:

- Pixel options dùng `event_id = order_<id>`
- CAPI event dùng `id = order_<id>`
- Hai event dùng cùng Pixel ID.

Không tạo hai ID khác nhau cho cùng một đơn hàng.

## 6. Kiểm thử

Có thể gửi `"validate_only": true` để OpenAI kiểm tra payload mà không lưu event. Sau đó trigger event thật và kiểm tra Recent Events trong Ads Manager trong khoảng 15 phút gần nhất.
