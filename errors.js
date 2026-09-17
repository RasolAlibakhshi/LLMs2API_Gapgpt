export class ApiError extends Error {
  constructor(code, message, status = 500, { retryable = false, delivery = 'not_sent' } = {}) {
    super(message);
    Object.assign(this, { code, status, retryable, delivery });
  }
}

export function asApiError(error, delivery = 'not_sent') {
  if (error instanceof ApiError) return error;
  const message = error?.message || 'Unexpected server error';
  if (/message_limit|sub_upgrade|quota/i.test(message)) {
    return new ApiError('upstream_quota', 'GapGPT account message limit reached.', 429, { delivery: 'rejected' });
  }
  if (/unauthoriz|sign.?in|login|session.expired/i.test(message)) {
    return new ApiError('login_required', 'Sign in to GapGPT in the server browser.', 503, { delivery });
  }
  if (/closed|disconnect|crash|browser not initialized/i.test(message)) {
    return new ApiError('browser_unavailable', 'Browser connection or conversation tab was closed.', 503,
      { delivery, retryable: delivery === 'not_sent' });
  }
  if (/timeout|timed out/i.test(message)) {
    return new ApiError('upstream_timeout', 'GapGPT did not respond before the timeout.', 504,
      { delivery, retryable: delivery === 'not_sent' });
  }
  return new ApiError('upstream_error', message, 502, { delivery });
}

export function errorBody(error) {
  const e = asApiError(error);
  return { error: { code: e.code, message: e.message, retryable: e.retryable, delivery: e.delivery } };
}
