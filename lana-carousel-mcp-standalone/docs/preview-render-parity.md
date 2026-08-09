# Ảnh preview và ảnh tải về phải trùng nhau

Studio có **hai bộ dựng ảnh độc lập** cho cùng một thiết kế:

| | Preview (bước "Sửa thiết kế") | Ảnh tải về / ZIP / video |
| --- | --- | --- |
| Nơi chạy | Trình duyệt | Node + `sharp` |
| Code | `background()` trong `public/widget.js` + `.canvas*` trong `public/stitch-ui.css` | `renderSlideSnapshot()` trong `src/service-core.js` |

Không có bước nào ép hai bên khớp nhau, nên **mọi thay đổi ở một bên phải được nhân bản sang bên kia**.
`src/render-preview-parity.test.js` chốt lại các quy tắc dưới đây.

## Các quy tắc bắt buộc

### 1. Cắt ảnh luôn canh giữa

`object-fit: cover` của trình duyệt luôn cắt ở tâm. Vì vậy `resize()` phía server **bắt buộc** dùng
`position: "centre"`. Các chiến lược phụ thuộc nội dung (`"attention"`, `"entropy"`, `sharp.strategy.*`)
chọn vùng theo entropy/độ nổi bật của ảnh nên cho ra khung hình hoàn toàn khác preview — với ảnh người mẫu
thì thường là cận mặt thay vì toàn thân.

### 2. Zoom và trọng tâm

Preview: ảnh phủ ô rồi `transform: scale(z)` với `transform-origin: cropX% cropY%`.
Server: resize phủ khung ở kích thước `(W·z, H·z)` rồi `extract()` cửa sổ `W×H` tại
`left = (W·z − W)·cropX/100`. Hai công thức này tương đương nhau; đừng đổi một bên mà quên bên kia.

### 3. Lật ảnh trước, phóng to sau

`flop()`/`flip()` của sharp lật ảnh gốc trước khi phủ khung. Phía preview phải lật ở thẻ `<img>`
(quanh tâm ảnh) và phóng to ở lớp bọc `.canvas-zoom` (quanh trọng tâm) — không gộp cả hai vào một
`transform` vì khi đó chúng dùng chung một `transform-origin` và cho kết quả khác.

### 4. Chỉnh màu theo đúng công thức của CSS filter

Preview dùng chuỗi `brightness() contrast() saturate() grayscale() hue-rotate() blur()`, tất cả đều là
phép tuyến tính trên sRGB. Phía server phải tái hiện đúng như vậy:

- `brightness(b)` rồi `contrast(c)` → `linear(b·c, 128·(1−c))`
- `saturate(s)` rồi `grayscale(g)` rồi `hue-rotate(d)` → một ma trận `recomb()` duy nhất

Không dùng `modulate()` của sharp: nó làm việc trong không gian LCh nên `brightness: 1.5` cho ra
màu khác hẳn `brightness(1.5)` của CSS.

### 5. Lọc màu sau khi ghép lưới, trước khi vẽ khung và chữ

Preview đặt `filter` lên `.canvas-bg` — tức là lên toàn bộ nền ảnh đã ghép, còn khung viền và các lớp chữ
nằm ngoài bộ lọc. Bản render phải theo đúng thứ tự đó, nếu lọc từng ô lưới thì vệt blur ở mép ô sẽ khác.

### 6. Ô lưới trống, viền "vừa cả ảnh" và vùng trong suốt

Cả ba đều lấy màu `imageBackground` của slide, không dùng màu cố định.

Riêng vùng trong suốt cần lưu ý: `resize({ background })` của sharp **chỉ** tô phần viền sinh ra bởi
`fit: "contain"`, nó không đụng tới kênh alpha có sẵn trong ảnh nguồn. Với PNG/WebP trong suốt, phải
`flatten({ background })` trước khi lọc màu — nếu không, ảnh tải về giữ nguyên vùng trong suốt trong khi
preview hiện màu nền, vì trình duyệt vẽ `background` của `.canvas-bg` nằm dưới ảnh.

Vì màu nền đó nằm *trong* phạm vi `filter` của `.canvas-bg`, bước `flatten()` phải chạy **trước**
`applyImageFilters()` để màu nền cũng được chỉnh sáng/tương phản như ở preview.

### 7. Font

Trình duyệt và server phải nạp **cùng một bộ file font**. Chúng nằm ở `public/fonts/`: trình duyệt nạp
qua `@font-face` trong `public/fonts.css`, còn librsvg (bên trong sharp) nạp qua fontconfig do
`src/fonts.js` cấu hình. Không dùng Google Fonts cho phía trình duyệt nữa — nếu chỉ một phía có font
thì mọi lựa chọn trong ô chọn font đều im lặng rơi về font mặc định của hệ thống ở bản render.

`src/fonts.js` phải được `import` **trước** `sharp`, vì fontconfig chỉ đọc biến `FONTCONFIG_FILE`
một lần cho cả tiến trình. Thêm font mới thì phải cập nhật cả `FONT_FILES`, `public/fonts.css` và
danh sách `fonts` trong `public/widget.js` — `src/render-fonts.test.js` chốt ba nơi này khớp nhau.

### 8. Chữ

Bản render tự xuống dòng, còn trình duyệt dùng bộ xếp chữ riêng, nên đây là phần khớp *gần đúng*.
Các hằng số phải bám theo CSS:

- `LINE_HEIGHT` = `.layer{line-height}` trong `stitch-ui.css`
- Hộp chữ dùng `box-sizing: border-box`: bề rộng chữ khả dụng = `boxWidth − 2·(padding + border)`
- `opacity` của lớp chữ áp cho cả hộp lẫn chữ

Bề rộng ký tự lấy từ chính file font qua `src/font-metrics.js`, không dùng hệ số ước lượng. Ba điểm
dễ sai khi sửa phần này:

- **`hmtx` chỉ mô tả instance mặc định.** Với font biến thiên phải cộng delta từ `HVAR`. Trục mặc định
  không nhất thiết là 400 — Montserrat mặc định 100, TikTok Sans mặc định 300 — nên bỏ qua `HVAR`
  thì sai ngay cả ở độ đậm thường.
- **CSS bật `font-optical-sizing: auto`.** Font có trục `opsz` phải được gán trục này theo cỡ chữ.
- **Họ nhiều file tĩnh** (Poppins) phải chọn file gần với độ đậm đang dùng.

Sai số bề rộng còn lại so với Chromium là dưới ~3,5% (chủ yếu do kerning chưa xử lý), nên ở đúng
ngưỡng ngắt dòng vẫn có thể lệch một từ. Muốn khớp tuyệt đối thì phải đo ở trình duyệt rồi gửi kèm
khi lưu thiết kế.

## Cách kiểm tra thủ công

`src/render-preview-parity.test.js` chạy tự động cùng `npm test`. Khi muốn so trực tiếp bằng mắt, dựng
một trang HTML lặp lại đúng cấu trúc `.canvas > .canvas-bg > div > .canvas-zoom > img` với cùng chuỗi
`filter`, chụp màn hình ở 1080×1920 rồi so từng điểm ảnh với kết quả của `renderSlideSnapshot()`.
Sai lệch trung bình mỗi kênh nên dưới ~2/255 (phần dư đến từ khác biệt thuật toán nội suy).
