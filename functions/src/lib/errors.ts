/**
 * Uniform error shape so the widget and dashboard can render failures without
 * parsing prose, and so prospect-facing errors never leak internals.
 */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'token_expired'
  | 'token_revoked'
  | 'not_published'
  | 'stale_terms'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'ai_unavailable'
  | 'ai_invalid_response'
  | 'commercial_violation'
  | 'origin_not_allowed'
  | 'internal_error';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string) => new AppError(400, 'bad_request', m);
export const unauthorized = (m = 'Not authorised') => new AppError(401, 'unauthorized', m);
export const forbidden = (m = 'Forbidden') => new AppError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new AppError(404, 'not_found', m);
/** State conflict: the caller's copy of the record is stale. */
export const conflict = (m: string) => new AppError(409, 'stale_terms', m);
export const originNotAllowed = (m = 'Origin not allowed') =>
  new AppError(403, 'origin_not_allowed', m);

/**
 * Prospect-safe message set. Anything not in this map is reported as a generic
 * failure so internal detail (stack traces, provider messages, key errors)
 * cannot reach an anonymous visitor.
 */
const PROSPECT_SAFE: Partial<Record<ErrorCode, string>> = {
  bad_request: 'That request could not be processed.',
  token_expired: 'This proposal link has expired. Please request a new link.',
  token_revoked: 'This proposal link is no longer active. Please contact your representative.',
  not_published: 'This proposal is not currently available.',
  not_found: 'This proposal could not be found.',
  stale_terms: 'This proposal has been updated since you opened it. Please reload to review the current terms.',
  rate_limited: 'Too many messages in a short period. Please wait a moment and try again.',
  ai_unavailable: 'The assistant is temporarily unavailable. Please try again shortly.',
  ai_invalid_response: 'The assistant could not answer that safely. Please try rephrasing.',
  commercial_violation: 'I am not able to answer that here. Let me connect you with your representative.',
};

export function prospectMessage(err: unknown): { status: number; code: ErrorCode; message: string; retryAfter?: number } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      code: err.code,
      message: PROSPECT_SAFE[err.code] ?? 'Something went wrong. Please try again.',
      ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
    };
  }
  return { status: 500, code: 'internal_error', message: 'Something went wrong. Please try again.' };
}
