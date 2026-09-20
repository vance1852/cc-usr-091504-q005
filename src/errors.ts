/** Domain error with HTTP status + stable machine code. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'authentication required') =>
  new AppError(401, 'E_UNAUTHORIZED', message);
export const forbidden = (code: string, message: string) =>
  new AppError(403, code, message);
export const notFound = (resource: string) =>
  new AppError(404, 'E_NOT_FOUND', `${resource} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
