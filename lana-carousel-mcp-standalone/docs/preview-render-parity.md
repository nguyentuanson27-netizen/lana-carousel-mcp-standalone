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

### 9. Crop riêng của từng ô lưới đè lên crop cấp slide

`slide.assetCrops[assetId]` chứa `cropX`/`cropY`/`cropZoom` riêng cho một ô; trường nào thiếu thì ô
kế thừa giá trị cấp slide. Preview dùng `cropFor()` trong `preview-dom.js`, bản render dùng
`cropSettingsFor()` — hai hàm này phải cùng công thức. Mọi đường ghi thiết kế đều phải xử lý chúng:
lưu, nhân bản dự án **và khôi phục phiên bản** (khôi phục còn phải xoá những ô được chỉnh riêng sau
thời điểm chụp).

Thao tác kéo trên khung xem trước phải chuẩn hoá theo kích thước **ô đang chỉnh**, không phải cả
canvas: ở zoom `z`, khung nhìn chỉ trượt được `(z−1)` lần kích thước ô. Dùng kích thước canvas sẽ
làm thao tác kéo chậm đi đúng bằng số cột/số hàng của lưới.

Hai cái bẫy khi sửa phần kéo này, cả hai đều làm thao tác chết sau vài pixel:

- **Ảnh mặc định kéo–thả được.** Không chặn thì trình duyệt khởi động thao tác kéo ảnh gốc và bắn
  `pointercancel`. Cần `draggable="false"`, `-webkit-user-drag: none` và `preventDefault()`.
- **Đổi DOM giữa lúc kéo.** `stitch-ui.js` theo dõi `childList` toàn trang cùng các thuộc tính
  `class`/`disabled`/`data-design-saved`; observer chạy giữa chừng có thể cướp mất pointer capture.
  Vì vậy thao tác kéo chỉ đổi `style`, cập nhật số hiển thị qua `nodeValue`, và chỉ ghi lịch sử
  hoàn tác lúc thả chuột.

Trọng tâm mới luôn tính từ vị trí lúc **bấm chuột** cộng tổng độ dời, nhưng phép kiểm tra "không có
gì đổi" phải so với giá trị **đang áp dụng**. So với vị trí lúc bấm chuột thì lúc kéo đi rồi kéo về
đúng chỗ cũ, phép so sẽ thấy trùng và bỏ qua, khiến bản nháp kẹt ở vị trí trung gian cuối cùng.

### 10. Mọi độ dài tính bằng pixel đều thuộc hệ toạ độ 1080px

Preview biểu diễn chúng bằng `cqw` nên tự co giãn theo bề rộng canvas. Bản render vì thế phải nhân
với `width / 1080` (hằng `DESIGN_WIDTH`): cỡ chữ, đệm và viền hộp chữ, độ dày và bo góc khung, độ mờ.
Bỏ bước này thì ảnh chỉ đúng ở đúng 1080px và sai tỉ lệ khi render video vuông hoặc ngang.

Hệ quả: **đừng dùng `px` thô trong CSS cho thứ gì thuộc thiết kế** — nếu không, preview ở canvas
540px và bản render ở 1080px sẽ khác nhau.

### 11. Bề rộng ngắt dòng khi tắt hộp chữ phụ thuộc vị trí lớp chữ

`.layer` là khối định vị tuyệt đối chỉ đặt `left`, nên bề rộng co giãn của nó là khoảng trống từ
`left` tới mép phải canvas, rồi mới bị `max-width: 96%` chặn. Tức là lớp chữ ở `x = 50%` chỉ được
dùng nửa bề rộng canvas. Đây là hành vi có phần bất ngờ của CSS chứ không phải chủ ý thiết kế, nhưng
sửa nó sẽ làm mọi thiết kế đã lưu xuống dòng lại, nên bản render đang lặp lại đúng công thức này.
Nếu sau này muốn bỏ ràng buộc đó thì phải sửa đồng thời cả hai phía và chấp nhận thiết kế cũ đổi bố cục.

## Kiểm tra tự động

`src/preview-browser-parity.test.js` mở Chromium, dựng khung xem trước bằng **chính module
`public/preview-dom.js`** mà studio dùng cùng đúng file `stitch-ui.css`, chụp màn hình rồi so từng
điểm ảnh với `renderSlideSnapshot()`. Đây là lưới an toàn cho toàn bộ tài liệu này — các bài test
khác chỉ kiểm tra phía server nên không thấy được sai lệch do CSS.

Ngưỡng: lệch trung bình < 4/255 với ảnh, < 9/255 với ca có chữ (trình duyệt và librsvg khử răng cưa
khác nhau). Test tự bỏ qua khi máy không có Playwright/Chromium; CI cài Chromium ở bước riêng.

Muốn so bằng mắt thì chạy test với biến `CHROMIUM_PATH` trỏ tới Chromium có sẵn và thêm lệnh ghi
ảnh ra file trong hàm `compare()`.
