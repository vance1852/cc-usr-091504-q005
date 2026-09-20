/** 业务错误：携带稳定 code，HTTP 层据此映射状态码 */
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (what: string) => new AppError('NOT_FOUND', `${what}不存在`, 404),
  forbidden: (msg: string) => new AppError('FORBIDDEN', msg, 403),
  conflict: (code: string, msg: string) => new AppError(code, msg, 409),
  validation: (msg: string) => new AppError('VALIDATION_ERROR', msg, 400),
  state: (msg: string) => new AppError('INVALID_STATE', msg, 409),
};
