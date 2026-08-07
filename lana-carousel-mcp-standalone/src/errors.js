export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function publicError(error) {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
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
