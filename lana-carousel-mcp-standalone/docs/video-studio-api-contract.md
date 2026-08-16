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

Hệ quả cho mọi route: **đừng `throw new Error("câu tiếng Việt")`**. `publicError()` thay câu đó bằng
"Lỗi hệ thống." nên công sức viết thông báo đổ sông. Muốn câu đó tới được người dùng thì phải là
`AppError` kèm mã trạng thái.

## 2b. Lỗi của middleware cũng phải là JSON

`express.json` gặp thân quá lớn hoặc JSON hỏng, `express.raw` gặp content-type ngoài danh sách,
`express.static` không thấy tệp — cả ba đều ném lỗi **trước khi** request tới được route, nên không
đi qua `safe()`/`handle()`. Bộ xử lý mặc định của Express trả về HTML kèm stack trace; giao diện gọi
`response.json()` trên đó là ném lỗi và nút bấm chết lặng.

Bộ xử lý lỗi cuối `src/http-server.js` giữ nguyên mã 4xx do middleware gắn và chỉ thay thân bằng
JSON. Mã 5xx vẫn đi qua `publicError()` vì có thể mang theo chi tiết nội bộ. Nó phải đứng **sau**
mọi route và middleware tĩnh — đặt sớm hơn là chặn mất cả trang bình thường, nên
`src/http-error-shape.test.js` kiểm luôn cả nhánh phục vụ trang.

Thông báo lỗi của nhà cung cấp cũng phải cắt ngắn và không kéo theo nguyên văn phản hồi HTTP:
thân phản hồi của Vertex chứa đường dẫn model kèm project id và chi tiết IAM, còn `/voice-sample`
với `/voice-preview` thì mở cho cả phiên chia sẻ link. Chi tiết đầy đủ đi vào log máy chủ.

## 2c. Mọi nút gọi mạng đều phải bắt lỗi

`api()` ném khi phản hồi không `ok`. Nút nào gọi mà quên `.catch()` thì lỗi chỉ hiện trong console,
người dùng thấy bấm xong không có gì xảy ra — khó lần ra hơn cả một thông báo sai. Riêng nút tải
tệp lên không dùng `api()` nên phải tự đọc phản hồi kiểu phòng thủ: nhánh lỗi của nó có thể không
phải JSON.

Vòng theo dõi job trong `poll()` cũng vậy, mà còn nặng hơn: nó chạy trong `setInterval` nên không
có ai bắt lỗi giùm. Một lượt hỏi hỏng thành unhandled rejection lặp lại mỗi 2 giây, vòng lặp không
bao giờ dừng và dòng trạng thái đứng im ở con số cuối cùng.

## 4. Lưu trước khi tải phải giữ nguyên trạng thái duyệt

Xuất phụ đề và nghe thử giọng đọc đều lưu nháp trước để tệp khớp thứ đang thấy trên màn hình.
Lưu bằng `save(false)` hạ một dự án **đã duyệt** xuống `DRAFT`, và người dùng chỉ phát hiện ra ở
lần bấm Render kế tiếp khi nó đòi duyệt lại. Dùng `save(keepApproval())`.

## 5. Chuỗi do người gọi API đặt không được vào `innerHTML`

`note` của phiên bản đi thẳng từ thân `PUT /script`. Danh sách phiên bản dựng bằng DOM
(`textContent` + `replaceChildren`) để những chuỗi đó ở lại dạng văn bản.

## 3. Thân yêu cầu chỉ tồn tại trong trình duyệt

`settings()` và `segments()` trong `public/video-studio.js` ghép thân yêu cầu từ các ô của form
ngay lúc bấm nút, nên không bài test phía server nào nhìn thấy bản thật. Bản mô phỏng trong test
có thể trôi khỏi bản thật lúc nào không hay — chính khoảng trôi đó là chỗ lỗi đã nằm im.
`src/video-studio-save-browser.test.js` mở studio bằng Chromium và bấm đúng cái nút thật; CI cài
Chromium ở bước riêng.
