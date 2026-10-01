/**
 * 统一错误契约。
 *
 * 对外错误响应形状（需求 §4）：
 *   { "error": { "code": "...", "message": "...", "requestId": "...", ...业务字段 } }
 *
 * 约定了若干固定映射：
 *   - HTTP 401 → code = UNAUTHORIZED
 *   - HTTP 403 → code = FORBIDDEN
 *   - 请求体校验失败 → 400 VALIDATION_ERROR
 *
 * 业务字段（例如后续的 stepIndex / key）直接平铺到 error 对象里。
 */

/** 错误码常量。后续切片只增不改，避免前端依赖的字符串发生漂移。 */
export const ErrorCode = {
  // 通用
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // 账号（切片 2）
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  CAS_CONFLICT: 'CAS_CONFLICT',

  // 出站（切片 3）
  ACCOUNT_UNAVAILABLE: 'ACCOUNT_UNAVAILABLE',
  ACCOUNT_NOT_IN_GROUP: 'ACCOUNT_NOT_IN_GROUP',

  // 建群（切片 4）
  ACCOUNT_NOT_ONLINE: 'ACCOUNT_NOT_ONLINE',

  // 定时序列（切片 5）
  SEQUENCE_ALREADY_RUNNING: 'SEQUENCE_ALREADY_RUNNING',
  UNRESOLVED_PLACEHOLDER: 'UNRESOLVED_PLACEHOLDER',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 业务字段：平铺进 error 对象，类型上允许字符串/数字/布尔/null。 */
export type ErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

/**
 * 可预期的业务错误。抛出后由全局 errorHandler 转成统一响应。
 * 与之相对的是未知异常（编程错误），统一转成 500 INTERNAL_ERROR 且不泄露内部信息。
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCodeValue,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: ErrorDetails): AppError {
    return new AppError(400, ErrorCode.VALIDATION_ERROR, message, details);
  }

  static unauthorized(message = '未认证或凭证已失效'): AppError {
    return new AppError(401, ErrorCode.UNAUTHORIZED, message);
  }

  static forbidden(message = '无权执行该操作'): AppError {
    return new AppError(403, ErrorCode.FORBIDDEN, message);
  }

  static notFound(message = '资源不存在', details?: ErrorDetails): AppError {
    return new AppError(404, ErrorCode.NOT_FOUND, message, details);
  }

  static conflict(code: ErrorCodeValue, message: string, details?: ErrorDetails): AppError {
    return new AppError(409, code, message, details);
  }
}

/** 对外错误响应体。 */
export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    [key: string]: unknown;
  };
}
