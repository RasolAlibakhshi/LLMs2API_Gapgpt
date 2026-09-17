import { randomUUID } from 'node:crypto';
import { createConversation } from './conversation.js';
import { createConversationStore, digest } from './conversation-store.js';
import { ApiError, asApiError } from './errors.js';

export function validateConversationId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new ApiError('invalid_conversation_id', 'conversation_id must contain 1–128 letters, digits, underscores or hyphens.', 400);
  }
  return id;
}

export function createTokenConversations(contextProvider, {
  url, timeout, store = createConversationStore(), maxPages = 6, maxConcurrent = 3,
  maxPending = 100, maxTokenPending = 20, maxConversationPending = 10,
  maxConversations = 1000, maxTokenConversations = 100,
  idleMs = 600000, requestHistory = 100, now = Date.now
} = {}) {
  const sessions = new Map(), tokenPending = new Map(), flights = new Map();
  const waiters = [];
  let active = 0, pending = 0, poolTail = Promise.resolve(), stopping = false;
  maxConcurrent = Math.min(maxConcurrent, maxPages);
  const busyError = message => new ApiError('capacity_exceeded', message, 429, { retryable: true });
  const keyOf = (owner, id) => `${owner}:${id}`;

  function recordFor(owner, id) {
    const existing = store.get(owner, id);
    if (existing) return existing;
    if (store.records.size >= maxConversations) throw busyError('Stored conversation limit reached.');
    if ([...store.records.values()].filter(r => r.owner === owner).length >= maxTokenConversations) {
      throw busyError('Conversation limit for this token reached.');
    }
    return store.create(owner, id);
  }
  function sessionFor(record) {
    const key = keyOf(record.owner, record.id);
    if (!sessions.has(key)) sessions.set(key, {
      record, page: null, conversation: null, tail: Promise.resolve(), pending: 0,
      busy: false, lastUsed: now(), request: null
    });
    return sessions.get(key);
  }
  async function acquire() {
    if (active < maxConcurrent) { active++; return; }
    await new Promise(resolve => waiters.push(resolve));
  }
  function release() {
    if (waiters.length) waiters.shift()();
    else active--;
  }
  async function poolLock(fn) {
    const previous = poolTail;
    let unlock;
    poolTail = new Promise(resolve => { unlock = resolve; });
    await previous;
    try { return await fn(); } finally { unlock(); }
  }
  function savedUrl(value, chatToken) {
    try {
      const candidate = new URL(value), base = new URL(url);
      return candidate.origin === base.origin && candidate.pathname.startsWith(base.pathname) &&
        !!chatToken && (candidate.pathname.split('/').includes(chatToken) ||
          [...candidate.searchParams.values()].includes(chatToken));
    } catch { return false; }
  }
  function remember(entry, state = {}) {
    const record = entry.record;
    if (record.chatToken && state.chatToken && record.chatToken !== state.chatToken) {
      throw new ApiError('history_unavailable', 'GapGPT replied from a different conversation. The original mapping was preserved.', 409, { delivery: 'unknown' });
    }
    const chatToken = state.chatToken || record.chatToken;
    const current = entry.page?.url?.();
    if (savedUrl(current, chatToken) && (record.url !== current || record.chatToken !== chatToken)) {
      record.url = current;
      record.chatToken = chatToken;
      record.updatedAt = new Date(now()).toISOString();
      store.flush();
    }
  }
  async function closeEntry(entry) {
    if (entry.closing) return entry.closing;
    const page = entry.page, conversation = entry.conversation;
    entry.page = null;
    entry.conversation = null;
    entry.closing = (async () => {
      try { if (page && !page.isClosed()) await page.close(); }
      catch (error) {
        entry.page = page;
        entry.conversation = conversation;
        throw error;
      }
    })();
    try { await entry.closing; } finally { entry.closing = null; }
  }
  async function open(entry) {
    if (entry.closing) await entry.closing;
    if (entry.page && !entry.page.isClosed()) return;
    const record = entry.record;
    if (record.attempted && !record.url) {
      throw new ApiError('history_unavailable', 'The previous chat URL was not recovered. Create a new conversation explicitly.', 409);
    }
    if (record.url && !savedUrl(record.url, record.chatToken)) {
      throw new ApiError('history_unavailable', 'Saved conversation URL is invalid.', 409);
    }
    // Retry setup only. Never repeat a message after clicking Send.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await poolLock(async () => {
          const opened = [...sessions.values()].filter(e => e.page && !e.page.isClosed());
          if (opened.length >= maxPages) {
            const victim = opened.filter(e => !e.busy && (!e.record.attempted || e.record.url))
              .sort((a, b) => a.lastUsed - b.lastUsed)[0];
            if (!victim) throw busyError('All chat tabs are busy or cannot safely be restored.');
            await closeEntry(victim);
          }
          const context = typeof contextProvider === 'function' ? await contextProvider() : contextProvider;
          entry.page = await context.newPage();
        });
        await entry.page.goto(record.url || url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        entry.conversation = createConversation(entry.page, {
          timeout,
          onBeforeSend() {
            if (!record.attempted && entry.page.url() !== url) {
              throw new ApiError('history_unavailable', 'The new-chat page redirected to another page. No message was sent.', 409);
            }
            if (record.url && !savedUrl(entry.page.url(), record.chatToken)) {
              const login = /login|sign-?in|auth/i.test(entry.page.url());
              throw new ApiError(login ? 'login_required' : 'history_unavailable',
                login ? 'Sign in to GapGPT in the server browser.' : 'The saved conversation is no longer open. No message was sent.', login ? 503 : 409);
            }
            if (entry.request) {
              const entries = Object.entries(record.requests);
              if (entries.length >= requestHistory) {
                const oldest = entries.filter(([, r]) => r.status === 'done').sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
                if (!oldest) throw busyError('Too many unresolved request keys in this conversation.');
                delete record.requests[oldest[0]];
              }
              record.requests[entry.request.key] = { fingerprint: entry.request.fingerprint, status: 'pending', createdAt: now() };
            }
            record.attempted = true;
            record.updatedAt = new Date(now()).toISOString();
            store.flush();
          },
          async onProgress(state) {
            remember(entry, state);
            if (state.complete && !state.error && !record.url && state.chatToken && entry.page.waitForURL) {
              await entry.page.waitForURL(value => savedUrl(String(value), state.chatToken), { timeout: 5000 }).catch(() => {});
              remember(entry, state);
            }
          }
        });
        return;
      } catch (error) {
        await closeEntry(entry).catch(() => {});
        const e = asApiError(error);
        if (attempt === 1 || !['browser_unavailable', 'upstream_timeout'].includes(e.code)) throw e;
      }
    }
  }

  const api = {
    create(token, id = randomUUID()) {
      if (stopping) throw new ApiError('server_stopping', 'Server is shutting down.', 503);
      validateConversationId(id);
      const record = recordFor(digest(token), id);
      return { id: record.id, created_at: record.createdAt };
    },
    list(token) {
      const owner = digest(token);
      return [...store.records.values()].filter(r => r.owner === owner).map(r => ({
        id: r.id, created_at: r.createdAt, updated_at: r.updatedAt, resumable: !!r.url
      }));
    },
    async generate(token, prompt, model = 'gapgpt', onChunk = null, { conversationId = 'default', requestId } = {}) {
      if (stopping) throw new ApiError('server_stopping', 'Server is shutting down.', 503, { retryable: true });
      if (!token) throw new ApiError('token_required', 'A conversation token is required.', 401);
      validateConversationId(conversationId);
      const owner = digest(token), key = keyOf(owner, conversationId);
      const requestKey = requestId ? digest(requestId) : null;
      const fingerprint = digest(JSON.stringify([prompt, model]));
      const flightKey = requestKey ? `${key}:${requestKey}` : null;
      const prior = requestKey && store.get(owner, conversationId)?.requests[requestKey];
      const flight = flightKey && flights.get(flightKey);
      if (flight || prior) {
        if ((flight || prior).fingerprint !== fingerprint) {
          throw new ApiError('idempotency_conflict', 'This request key was already used with different content or model.', 409);
        }
        let text;
        if (flight) text = await flight.promise;
        else if (prior.status === 'done') text = prior.text;
        else throw new ApiError('request_outcome_unknown', 'The earlier request may have been sent. Check the chat before submitting a new request key.', 409, { delivery: 'unknown' });
        onChunk?.(text);
        return text;
      }
      if (pending >= maxPending || (tokenPending.get(owner) || 0) >= maxTokenPending) {
        throw busyError('Too many outstanding requests. Try again after the current requests finish.');
      }
      const entry = sessionFor(recordFor(owner, conversationId));
      if (entry.pending >= maxConversationPending) throw busyError('Conversation queue is full.');
      pending++;
      tokenPending.set(owner, (tokenPending.get(owner) || 0) + 1);
      entry.pending++;
      const result = entry.tail.then(async () => {
        await acquire();
        entry.busy = true;
        entry.request = requestKey ? { key: requestKey, fingerprint } : null;
        const previouslyAttempted = entry.record.attempted;
        try {
          await open(entry);
          const text = await entry.conversation.generate(prompt, model, onChunk);
          remember(entry);
          if (!entry.record.url) {
            throw new ApiError('history_unavailable', 'Message completed, but its chat URL could not be saved. Keep the tab open and check the chat before retrying.', 502, { delivery: 'unknown' });
          }
          if (requestKey) entry.record.requests[requestKey] = { fingerprint, status: 'done', text, createdAt: now() };
          entry.record.updatedAt = new Date(now()).toISOString();
          try { store.flush(); } catch (error) { error.delivery = 'unknown'; throw error; }
          return text;
        } catch (error) {
          const e = asApiError(error);
          if (['not_sent', 'rejected'].includes(e.delivery)) {
            if (!entry.record.url) entry.record.attempted = previouslyAttempted;
            if (requestKey) delete entry.record.requests[requestKey];
            store.flush();
          }
          if (e.delivery === 'not_sent' && ['history_unavailable', 'login_required', 'composer_unavailable'].includes(e.code)) {
            await closeEntry(entry).catch(() => {});
          }
          throw e;
        } finally {
          entry.request = null;
          entry.busy = false;
          entry.pending--;
          pending--;
          const remaining = tokenPending.get(owner) - 1;
          if (remaining) tokenPending.set(owner, remaining); else tokenPending.delete(owner);
          entry.lastUsed = now();
          release();
        }
      });
      entry.tail = result.catch(() => {});
      if (flightKey) flights.set(flightKey, { fingerprint, promise: result });
      try { return await result; }
      finally { if (flightKey) flights.delete(flightKey); }
    },
    async sweep() {
      await poolLock(async () => {
        for (const [key, entry] of sessions) {
          if (!entry.pending && !entry.busy && now() - entry.lastUsed >= idleMs && (!entry.record.attempted || entry.record.url)) {
            await closeEntry(entry);
            // A request may have arrived while the browser was closing the tab.
            if (!entry.pending && !entry.busy) sessions.delete(key);
          }
        }
      });
    },
    async shutdown() {
      stopping = true;
      await Promise.all([...sessions.values()].map(e => e.tail));
      store.flush();
      await Promise.all([...sessions.values()].map(closeEntry));
    },
    get stats() {
      return {
        totalPages: [...sessions.values()].filter(e => e.page && !e.page.isClosed()).length,
        busyPages: [...sessions.values()].filter(e => e.busy).length,
        queuedRequests: pending - active,
        maxPages, maxConcurrent, storedConversations: store.records.size
      };
    }
  };
  return api;
}
