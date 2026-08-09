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

### 6. Ô lưới trống và viền của chế độ "vừa cả ảnh"

Cả hai đều lấy màu `imageBackground` của slide, không dùng màu cố định.

### 7. Chữ

Bản render tự xuống dòng bằng ước lượng bề rộng ký tự, còn trình duyệt dùng metric thật của font, nên
đây là phần khớp *gần đúng*. Các hằng số phải bám theo CSS:

- `LINE_HEIGHT` = `.layer{line-height}` trong `stitch-ui.css`
- Hộp chữ dùng `box-sizing: border-box`: bề rộng chữ khả dụng = `boxWidth − 2·(padding + border)`
- `opacity` của lớp chữ áp cho cả hộp lẫn chữ

Nếu cần khớp tuyệt đối phần chữ thì phải đo bề rộng dòng ở trình duyệt rồi gửi kèm khi lưu thiết kế.

## Cách kiểm tra thủ công

`src/render-preview-parity.test.js` chạy tự động cùng `npm test`. Khi muốn so trực tiếp bằng mắt, dựng
một trang HTML lặp lại đúng cấu trúc `.canvas > .canvas-bg > div > .canvas-zoom > img` với cùng chuỗi
`filter`, chụp màn hình ở 1080×1920 rồi so từng điểm ảnh với kết quả của `renderSlideSnapshot()`.
Sai lệch trung bình mỗi kênh nên dưới ~2/255 (phần dư đến từ khác biệt thuật toán nội suy).
