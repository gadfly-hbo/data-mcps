import type { ErrorCategory } from "./types.js";

/** 业务错误：HTTP 状态码与 category 对应表封存于此（GRILL 包 1）。 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly category: ErrorCategory,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorBody(err: AppError): { error: Record<string, unknown> } {
  const error: Record<string, unknown> = { category: err.category, message: err.message };
  if (err.details !== undefined) error.details = err.details;
  if (err.retryAfterSeconds !== undefined) error.retryAfterSeconds = err.retryAfterSeconds;
  return { error };
}

export const errors = {
  badRequest: (msg: string, details?: Record<string, unknown>) =>
    new AppError(400, "bad_request", msg, details),
  notFound: (msg: string) => new AppError(404, "not_found", msg),
  permissionDenied: (msg: string, details?: Record<string, unknown>) =>
    new AppError(403, "permission_denied", msg, details),
  scopeInsufficient: (msg: string, details?: Record<string, unknown>) =>
    new AppError(403, "scope_insufficient", msg, details),
  licenseDenied: (msg: string, details?: Record<string, unknown>) =>
    new AppError(403, "license_denied", msg, details),
  authInvalid: (msg: string) => new AppError(401, "auth_invalid", msg),
  rateLimited: (msg: string, retryAfterSeconds?: number) =>
    new AppError(429, "rate_limited", msg, undefined, retryAfterSeconds),
  quotaExhausted: (msg: string) => new AppError(429, "quota_exhausted", msg),
  validationFailed: (msg: string, details?: Record<string, unknown>) =>
    new AppError(422, "validation_failed", msg, details),
  staleParams: (msg: string) => new AppError(409, "stale_params", msg),
  saveFailed: (msg: string, details?: Record<string, unknown>) =>
    new AppError(500, "save_failed", msg, details),
};
