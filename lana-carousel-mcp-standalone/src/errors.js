export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Thân yêu cầu sai định dạng là lỗi của người gọi, không phải sự cố máy chủ. Không nhận diện
// ZodError ở đây thì mọi lệch schema đều rơi xuống nhánh 500 "Lỗi hệ thống." — người dùng tưởng
// server hỏng, còn lập trình viên mất luôn tên trường sai. Nhận diện theo hình dạng chứ không
// dùng `instanceof`: zod có thể tồn tại nhiều bản trong cây phụ thuộc và mỗi bản một lớp riêng.
const zodIssues = error => (error?.name === "ZodError" && Array.isArray(error.issues) ? error.issues : null);

export function publicError(error) {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const issues = zodIssues(error);
  if (issues) {
    const issue = issues[0];
    const field = issue?.path?.join(".") || "body";
    return {
      status: 422,
      code: "INVALID_REQUEST",
      message: `Yêu cầu không hợp lệ ở "${field}": ${issue?.message || "dữ liệu sai"}.`
    };
  }
  if (/CANDIDATE_LIMIT_REACHED/u.test(String(error?.message || error || ""))) {
    return {
      status: 409,
      code: "CANDIDATE_LIMIT_REACHED",
      message: "Mỗi slide chỉ được gắn tối đa 10 ảnh ứng viên."
    };
  }
  console.error(error);
  return { status: 500, code: "INTERNAL_ERROR", message: "Lỗi hệ thống." };
}
