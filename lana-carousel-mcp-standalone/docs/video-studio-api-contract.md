# Hợp đồng giữa Video Studio và API

Studio ở `/video-studio` không giữ trạng thái riêng: nó đọc dự án bằng `GET /api/video-analysis/projects/:id`,
dựng lại form từ đó, rồi khi bấm nút thì gửi ngược lên `PUT .../script`. Ba nút **Lưu bản nháp**,
**Duyệt script**, **Render MP4** và nút **Nghe thử giọng đọc trên video** đều đi qua đúng một
lượt `PUT` đó, nên một sai lệch nhỏ ở thân yêu cầu làm hỏng cả bốn cùng lúc.

## 1. `PUT` phải nhận lại được thứ `GET` vừa trả ra

`saveVideoAnalysisScript()` tự đánh số `order` cho từng đoạn theo vị trí trong mảng rồi lưu kèm,
nên bản lưu đọc ra luôn có trường đó. Studio gửi nguyên mảng lên lại. Schema `.strict()` của
`PUT` vì thế **bắt buộc** phải chấp nhận mọi trường mà bản lưu có thể chứa — kể cả những trường
chỉ do server sinh ra và bị bỏ qua khi ghi lại.

Trường `order` gửi lên không có tác dụng: thứ tự luôn được tính lại từ vị trí trong mảng. Nó tồn
tại trong schema chỉ để vòng đọc–ghi khép kín được.

Thêm trường mới vào bản lưu thì phải thêm vào schema cùng lúc. `src/video-analysis-script-round-trip.test.js`
chốt việc này bằng cách đọc dự án rồi gửi nguyên văn `script` lên lại.

## 2. Sai schema là lỗi 4xx và phải gọi tên trường sai

`publicError()` nhận diện `ZodError` và trả `422 INVALID_REQUEST` kèm đường dẫn tới trường hỏng.
Không có bước đó thì mọi lệch schema rơi xuống nhánh `500 "Lỗi hệ thống."`: người dùng tưởng máy
chủ hỏng, còn người sửa mất luôn manh mối duy nhất. Lỗi `order` ở trên sống sót qua nhiều lần
phát hành đúng vì lý do này.

Nhận diện theo `error.name === "ZodError"` chứ không dùng `instanceof`: cây phụ thuộc có thể chứa
nhiều bản zod, mỗi bản một lớp riêng.

Cũng vì vậy, lỗi từ nhà cung cấp TTS được `generateVideoTtsTrack()` gói thành `502 TTS_PROVIDER_FAILED`
kèm nguyên văn lý do — thiếu credential hay sai tên model phải đọc được ngay trên giao diện.

## 3. Thân yêu cầu chỉ tồn tại trong trình duyệt

`settings()` và `segments()` trong `public/video-studio.js` ghép thân yêu cầu từ các ô của form
ngay lúc bấm nút, nên không bài test phía server nào nhìn thấy bản thật. Bản mô phỏng trong test
có thể trôi khỏi bản thật lúc nào không hay — chính khoảng trôi đó là chỗ lỗi đã nằm im.
`src/video-studio-save-browser.test.js` mở studio bằng Chromium và bấm đúng cái nút thật; CI cài
Chromium ở bước riêng.
