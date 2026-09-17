import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTokenConversations } from '../token-conversations.js';
import { createConversationStore, digest } from '../conversation-store.js';
import { fakeSite, chatUrl, deferred } from '../test-support/fake-browser.js';

function disk(t) {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-state-'));
  assert.equal(path.dirname(directory), process.cwd());
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'conversations.json');
}
const manager = (site, options = {}) => createTokenConversations(site.context, { url: chatUrl, ...options });

test('restart restores remote history, multiple conversations and token isolation', async t => {
  const file = disk(t), site = fakeSite();
  const first = manager(site, { store: createConversationStore(file) });
  await first.generate('alice-secret', 'one', 'gapgpt', null, { conversationId: 'work' });
  await first.generate('alice-secret', 'two', 'gapgpt', null, { conversationId: 'personal' });
  await first.generate('bob-secret', 'three', 'gapgpt', null, { conversationId: 'work' });
  const firstUrl = site.pages[0].url();
  await first.shutdown();
  const saved = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(saved, /alice-secret|bob-secret/);
  const second = manager(site, { store: createConversationStore(file) });
  assert.equal(second.list('alice-secret').length, 2);
  assert.equal(second.list('bob-secret').length, 1);
  assert.equal(second.list('stranger').length, 0);
  await second.generate('alice-secret', 'followup', 'gapgpt', null, { conversationId: 'work' });
  assert.equal(site.navigations.at(-1), firstUrl);
  assert.deepEqual(site.chats.get(firstUrl), ['one', 'followup']);
  assert.equal(site.chats.size, 3);
});

test('idle tabs and LRU eviction preserve chats and never exceed the tab cap', async () => {
  let time = 0;
  const site = fakeSite(), sessions = manager(site, { maxPages: 2, idleMs: 10, now: () => time });
  await sessions.generate('a', 'first');
  const firstUrl = site.pages[0].url();
  time++;
  await sessions.generate('b', 'second');
  time++;
  await sessions.generate('c', 'third');
  assert.equal(site.pages[0].isClosed(), true);
  assert.equal(site.peak, 2);
  await sessions.generate('a', 'continued');
  assert.deepEqual(site.chats.get(firstUrl), ['first', 'continued']);
  time += 20;
  await sessions.sweep();
  assert.equal(sessions.stats.totalPages, 0);
  await sessions.generate('a', 'after idle');
  assert.deepEqual(site.chats.get(firstUrl), ['first', 'continued', 'after idle']);
  assert.equal(site.peak, 2);
});

test('manually closed tab reopens the saved URL', async () => {
  const site = fakeSite(), sessions = manager(site);
  await sessions.generate('a', 'first');
  const url = site.pages[0].url();
  await site.pages[0].close();
  await sessions.generate('a', 'second');
  assert.deepEqual(site.chats.get(url), ['first', 'second']);
  assert.equal(site.pages.length, 2);
});

test('a request arriving during idle closure waits and reopens the same chat', async () => {
  let time = 0;
  const site = fakeSite(), sessions = manager(site, { idleMs: 10, now: () => time });
  await sessions.generate('a', 'first');
  const original = site.pages[0], url = original.url(), started = deferred(), finish = deferred();
  const close = original.close;
  original.close = async () => { started.resolve(); await finish.promise; await close(); };
  time = 20;
  const cleanup = sessions.sweep();
  await started.promise;
  const message = sessions.generate('a', 'during cleanup');
  finish.resolve();
  await Promise.all([cleanup, message]);
  assert.deepEqual(site.chats.get(url), ['first', 'during cleanup']);
  assert.equal(sessions.stats.totalPages, 1);
  await sessions.generate('a', 'next');
  assert.equal(site.pages.length, 2);
  assert.deepEqual(site.chats.get(url), ['first', 'during cleanup', 'next']);
});

test('global concurrency, token and conversation queues are bounded; busy tabs survive cleanup', async () => {
  const gate = deferred(), started = deferred();
  const site = fakeSite({ afterClick: async () => { started.resolve(); await gate.promise; } });
  const sessions = manager(site, { maxPages: 1, maxConcurrent: 1, maxPending: 3,
    maxTokenPending: 2, maxConversationPending: 1, idleMs: 1 });
  const first = sessions.generate('a', 'first');
  await started.promise;
  await assert.rejects(sessions.generate('a', 'overflow'), { code: 'capacity_exceeded' });
  const second = sessions.generate('a', 'other chat', 'gapgpt', null, { conversationId: 'other' });
  await assert.rejects(sessions.generate('a', 'third chat', 'gapgpt', null, { conversationId: 'third' }), { code: 'capacity_exceeded' });
  const third = sessions.generate('b', 'another token');
  await assert.rejects(sessions.generate('c', 'too many'), { code: 'capacity_exceeded' });
  await sessions.sweep();
  assert.equal(sessions.stats.totalPages, 1);
  assert.equal(sessions.stats.busyPages, 1);
  assert.equal(sessions.stats.queuedRequests, 2);
  gate.resolve();
  assert.equal((await Promise.all([first, second, third])).length, 3);
  assert.equal(site.peak, 1);
  assert.equal(sessions.stats.queuedRequests, 0);
});

test('idempotency coalesces simultaneous calls, survives restart and rejects conflicting content', async t => {
  const file = disk(t), site = fakeSite();
  let sessions = manager(site, { store: createConversationStore(file) });
  const options = { requestId: 'request-1' }, chunks = [];
  const a = sessions.generate('a', 'hello', 'gapgpt', null, options);
  const b = sessions.generate('a', 'hello', 'gapgpt', chunk => chunks.push(chunk), options);
  assert.deepEqual(await Promise.all([a, b]), ['answer: hello', 'answer: hello']);
  assert.equal(chunks.join(''), 'answer: hello');
  assert.equal(site.pages[0].sent.length, 1);
  await assert.rejects(sessions.generate('a', 'different', 'gapgpt', null, options), { code: 'idempotency_conflict' });
  await sessions.shutdown();
  sessions = manager(site, { store: createConversationStore(file) });
  assert.equal(await sessions.generate('a', 'hello', 'gapgpt', null, options), 'answer: hello');
  assert.equal(site.pages.length, 1);
  await sessions.generate('b', 'hello', 'gapgpt', null, options);
  assert.equal(site.pages.length, 2);
});

test('timeout records uncertain delivery and blocks resending the same key after restart', async t => {
  const file = disk(t), site = fakeSite();
  let sessions = manager(site, { timeout: 5, store: createConversationStore(file) });
  const options = { requestId: 'uncertain' };
  await assert.rejects(sessions.generate('a', 'stall', 'gapgpt', null, options), {
    code: 'upstream_timeout', delivery: 'unknown', retryable: false
  });
  await sessions.shutdown();
  sessions = manager(site, { store: createConversationStore(file) });
  await assert.rejects(sessions.generate('a', 'stall', 'gapgpt', null, options), { code: 'request_outcome_unknown' });
  assert.equal(site.pages[0].sent.length, 1);
  assert.equal(sessions.list('a')[0].resumable, true);
});

test('disconnect during click is never replayed and missing history does not silently start a new chat', async () => {
  const site = fakeSite(), sessions = manager(site);
  const options = { requestId: 'lost' };
  await assert.rejects(sessions.generate('a', 'disconnect', 'gapgpt', null, options), {
    code: 'browser_unavailable', delivery: 'unknown', retryable: false
  });
  await assert.rejects(sessions.generate('a', 'disconnect', 'gapgpt', null, options), { code: 'request_outcome_unknown' });
  await assert.rejects(sessions.generate('a', 'next'), { code: 'history_unavailable' });
  assert.equal(site.pages.length, 1);
  const created = sessions.create('a');
  await sessions.generate('a', 'fresh', 'gapgpt', null, { conversationId: created.id });
  assert.equal(site.pages.length, 2);
});

test('quota rejection permits a safe later retry and does not poison a new conversation', async () => {
  const site = fakeSite(), sessions = manager(site);
  await assert.rejects(sessions.generate('a', 'quota', 'gapgpt', null, { requestId: 'quota-key' }), {
    code: 'upstream_quota', delivery: 'rejected'
  });
  await site.pages[0].close();
  await sessions.generate('a', 'later', 'gapgpt', null, { requestId: 'quota-key' });
  assert.equal(site.chats.size, 1);
});

test('setup disconnection can retry before Send, while a switched chat is rejected', async () => {
  let attempts = 0;
  const site = fakeSite({ beforeNavigate: async () => { if (++attempts === 1) throw new Error('Browser disconnected'); } });
  const sessions = manager(site);
  await sessions.generate('a', 'hello');
  assert.equal(site.pages.length, 2);
  assert.equal(site.pages[0].sent.length, 0);
  site.pages[1].redirect(chatUrl + 'different-chat');
  await assert.rejects(sessions.generate('a', 'wrong tab'), { code: 'history_unavailable', delivery: 'not_sent' });
  assert.deepEqual(site.pages[1].sent, ['hello']);
  await sessions.generate('a', 'recovered');
  assert.deepEqual([...site.chats.values()][0], ['hello', 'recovered']);
});

test('stored conversation limits and malformed data fail without overwriting history', async t => {
  const file = disk(t), site = fakeSite(), sessions = manager(site, { maxConversations: 2, maxTokenConversations: 1 });
  sessions.create('a', 'one');
  assert.throws(() => sessions.create('a', 'two'), { code: 'capacity_exceeded' });
  sessions.create('b', 'one');
  assert.throws(() => sessions.create('c', 'one'), { code: 'capacity_exceeded' });
  assert.throws(() => sessions.create('a', '../escape'), { code: 'invalid_conversation_id' });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => createConversationStore(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('untrusted saved URLs never navigate outside the chat site', async () => {
  const store = createConversationStore(), record = store.create(digest('a'), 'default');
  Object.assign(record, { url: 'https://other.test/chat/id', chatToken: 'id', attempted: true });
  const site = fakeSite(), sessions = manager(site, { store });
  await assert.rejects(sessions.generate('a', 'hello'), { code: 'history_unavailable' });
  assert.equal(site.pages.length, 0);
});
