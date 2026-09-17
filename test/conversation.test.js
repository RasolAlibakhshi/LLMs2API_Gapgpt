import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createCapture } from '../gapgpt-transport.js';
import { createConversation } from '../conversation.js';
import { createTokenConversations } from '../token-conversations.js';

// A page double that executes the real capture callbacks and rejects navigation.
function fakePage() {
  const capture = createCapture();
  const sandbox = vm.createContext({ window: { __gapgptCapture: capture } });
  let prompt, sequence = 0, closed = false, currentUrl = 'https://example.test/chat/';
  const sent = [];
  const input = {
    first() { return this; },
    async waitFor() {},
    async fill(text) { prompt = text; }
  };
  const button = {
    first() { return this; }, filter() { return this; }, async waitFor() {},
    async click() {
      const rid = ++sequence;
      const currentPrompt = prompt;
      sent.push(currentPrompt);
      capture.outgoing(JSON.stringify({ event: 'new_message', rid, data: { action: { type: 'text_message' } } }));
      await new Promise(resolve => setImmediate(resolve));
      if (currentPrompt === 'fail') {
        capture.incoming({ event: 'ack_new_message', rid, data: { status: 'sub_upgrade', message: 'message_limit' } });
        return;
      }
      // Delayed events from the preceding turn must not leak into this response.
      if (rid > 1) capture.incoming({ event: 'new_message', data: { message: {
        token: `m${rid - 1}`, chat_token: 'same-chat', status: 'completed',
        response: [{ type: 'text', block_id: 'b', content: 'stale answer' }]
      } } });
      capture.incoming({ event: 'ack_new_message', rid, data: { status: 'ok', message: {
        token: `m${rid}`, chat_token: 'same-chat', response: []
      } } });
      currentUrl = 'https://example.test/chat/same-chat';
      capture.incoming({ event: 'new_message', data: { message: {
        token: `m${rid}`, chat_token: 'same-chat', status: 'completed',
        response: [{ type: 'text', block_id: 'b', content: `answer: ${currentPrompt}` }]
      } } });
    }
  };
  return {
    sent,
    isClosed: () => closed,
    async close() { closed = true; },
    url: () => currentUrl,
    goto() { throw new Error('Conversation must not navigate'); },
    reload() { throw new Error('Conversation must not reload'); },
    locator(selector) { return selector.includes('textarea') ? input : button; },
    async evaluate(fn, arg) {
      sandbox.arg = arg;
      return vm.runInContext(`(${fn.toString()})(arg)`, sandbox);
    }
  };
}

test('concurrent requests continue one page in FIFO order and reset capture for each turn', async () => {
  const page = fakePage();
  const conversation = createConversation(page);
  const chunks = [];
  const first = conversation.generate('first');
  const second = conversation.generate('second', 'gapgpt', chunk => chunks.push(chunk));
  const third = conversation.generate('third');
  assert.deepEqual(await Promise.all([first, second, third]), ['answer: first', 'answer: second', 'answer: third']);
  assert.deepEqual(page.sent, ['first', 'second', 'third']);
  assert.equal(chunks.join(''), 'answer: second');
  assert.equal(conversation.busy, false);
  assert.equal(conversation.queued, 0);
});

test('a failed turn does not poison capture or block the next queued turn', async () => {
  const page = fakePage();
  const conversation = createConversation(page);
  const failed = conversation.generate('fail');
  const next = conversation.generate('retry');
  await assert.rejects(failed, { code: 'upstream_quota', delivery: 'rejected' });
  assert.equal(await next, 'answer: retry');
  assert.deepEqual(page.sent, ['fail', 'retry']);
});

test('closed tab reports an error without silently creating a different conversation', async () => {
  const page = fakePage();
  page.isClosed = () => true;
  await assert.rejects(createConversation(page).generate('hello'), /tab was closed/);
  assert.deepEqual(page.sent, []);
});

test('tokens reuse their own tab and queue, including simultaneous first requests', async () => {
  const pages = [];
  const sessions = createTokenConversations({ async newPage() {
    const page = fakePage();
    page.goto = async () => { await new Promise(resolve => setImmediate(resolve)); };
    pages.push(page);
    return page;
  } }, { url: 'https://example.test/chat/' });
  const results = await Promise.all([
    sessions.generate('alice', 'first'),
    sessions.generate('alice', 'second'),
    sessions.generate('bob', 'separate')
  ]);
  assert.deepEqual(results, ['answer: first', 'answer: second', 'answer: separate']);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].sent, ['first', 'second']);
  assert.deepEqual(pages[1].sent, ['separate']);
  await sessions.generate('alice', 'third');
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].sent, ['first', 'second', 'third']);
  assert.equal(sessions.stats.totalPages, 2);
  assert.equal(sessions.stats.busyPages, 0);
  assert.equal(sessions.stats.queuedRequests, 0);
});

test('a token waiting for its tab does not block another token; failed setup can retry', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0, closed = 0;
  const sessions = createTokenConversations({ async newPage() {
    const id = ++count;
    const page = fakePage();
    page.close = async () => { closed++; };
    page.goto = async () => { if (id === 1) { await gate; throw new Error('navigation failed'); } };
    return page;
  } }, { url: 'https://example.test/chat/' });
  const failed = assert.rejects(sessions.generate('alice', 'first'), /navigation failed/);
  try {
    assert.equal(await sessions.generate('bob', 'independent'), 'answer: independent');
  } finally { release(); }
  await failed;
  assert.equal(closed, 1);
  assert.equal(await sessions.generate('alice', 'retry'), 'answer: retry');
  assert.equal(count, 3);
});
