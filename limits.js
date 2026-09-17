import { digest } from './conversation-store.js';
import { ApiError } from './errors.js';

export function positiveSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const limits = {
  maxBodyBytes: positiveSetting('MAX_BODY_BYTES', 1048576),
  maxMessageChars: positiveSetting('MAX_MESSAGE_CHARS', 64000),
  maxPages: positiveSetting('MAX_CHAT_TABS', 6),
  maxConcurrent: positiveSetting('MAX_CONCURRENT_REQUESTS', 3),
  maxPending: positiveSetting('MAX_PENDING_REQUESTS', 100),
  maxTokenPending: positiveSetting('MAX_PENDING_PER_TOKEN', 20),
  maxConversationPending: positiveSetting('MAX_PENDING_PER_CONVERSATION', 10),
  maxConversations: positiveSetting('MAX_STORED_CONVERSATIONS', 1000),
  maxTokenConversations: positiveSetting('MAX_CONVERSATIONS_PER_TOKEN', 100),
  idleMs: positiveSetting('TAB_IDLE_TIMEOUT_MS', 600000),
  requestHistory: positiveSetting('IDEMPOTENCY_HISTORY_SIZE', 100)
};

export function createRateLimiter({ perToken = 60, global = 300, windowMs = 60000, now = Date.now } = {}) {
  let start = now(), total = 0;
  const tokens = new Map();
  return {
    check(token) {
      const time = now();
      if (time - start >= windowMs) { start = time; total = 0; tokens.clear(); }
      const key = digest(token), count = tokens.get(key) || 0;
      if (total >= global || count >= perToken) {
        const error = new ApiError('rate_limit_exceeded', 'Request rate limit reached.', 429, { retryable: true });
        error.retryAfter = Math.max(1, Math.ceil((start + windowMs - time) / 1000));
        throw error;
      }
      total++;
      tokens.set(key, count + 1);
    }
  };
}
