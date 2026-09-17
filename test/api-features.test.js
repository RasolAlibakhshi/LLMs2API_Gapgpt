import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handleRequest } from '../server.js';
import { createTokenConversations } from '../token-conversations.js';
import { createRateLimiter } from '../limits.js';
import { ApiError } from '../errors.js';
import { fakeSite, chatUrl } from '../test-support/fake-browser.js';

async function api(t, { generator, requestLimits = { maxBodyBytes: 1024, maxMessageChars: 100 }, limiter = createRateLimiter() } = {}) {
  const site = fakeSite(), manager = createTokenConversations(site.context, { url: chatUrl });
  const generate = generator || ((prompt, model, chunk, token, options) => manager.generate(token, prompt, model, chunk, options));
  const server = http.createServer((req, res) => handleRequest(req, res, generate, { manager, requestLimits, limiter }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, body, token = 'alice', headers = {}) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { call, base, site };
}
const message = content => [{ role: 'user', content }];

test('HTTP creates and lists scoped conversations and routes JSON, SSE and idempotent retries', async t => {
  const { call, site } = await api(t);
  const creation = await call('/v1/conversations', {});
  assert.equal(creation.status, 201);
  const { id } = await creation.json();
  assert.equal(site.pages.length, 0);
  const body = { conversation_id: id, messages: message('سلام دنیا') };
  const first = await call('/v1/chat/completions', body, 'alice', { 'Idempotency-Key': 'one' });
  assert.equal(first.headers.get('x-conversation-id'), id);
  assert.equal((await first.json()).conversation_id, id);
  const replay = await call('/v1/chat/completions', { ...body, stream: true }, 'alice', { 'Idempotency-Key': 'one' });
  const text = await replay.text();
  assert.match(text, /سلام دنیا/);
  assert.match(text, /\[DONE\]/);
  assert.equal(site.pages[0].sent.length, 1);
  const next = await call('/v1/chat/completions', { conversation_id: id, messages: message('followup') });
  assert.equal(next.status, 200);
  await next.text();
  assert.deepEqual([...site.chats.values()][0], ['سلام دنیا', 'followup']);
  const listed = await (await call('/v1/conversations')).json();
  assert.equal(listed.data[0].id, id);
  assert.equal(listed.data[0].resumable, true);
  assert.deepEqual((await (await call('/v1/conversations', undefined, 'bob')).json()).data, []);
  const defaultChat = await call('/v1/chat/completions', { messages: message('default') });
  assert.equal((await defaultChat.json()).conversation_id, 'default');
});

test('message, body and field limits reject before opening a tab', async t => {
  const { call, site } = await api(t, { requestLimits: { maxBodyBytes: 256, maxMessageChars: 10 } });
  for (const [body, status, code] of [
    [{ messages: message('12345678901') }, 413, 'message_too_large'],
    [{ messages: message('x'.repeat(300)) }, 413, 'body_too_large'],
    [{ conversation_id: '../bad', messages: message('ok') }, 400, 'invalid_conversation_id'],
    [{ messages: message('ok'), stream: 'true' }, 400, 'invalid_stream'],
    [[], 400, 'invalid_body'],
    [null, 400, 'invalid_body']
  ]) {
    const response = await call('/v1/chat/completions', body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  const key = await call('/v1/chat/completions', { messages: message('ok') }, 'alice', { 'Idempotency-Key': 'contains space' });
  assert.equal(key.status, 400);
  assert.equal(site.pages.length, 0);
});

test('rate limits apply to a token and globally and reset with Retry-After', async t => {
  let time = 0;
  const limiter = createRateLimiter({ perToken: 1, global: 2, windowMs: 1000, now: () => time });
  const { call } = await api(t, { limiter });
  assert.equal((await call('/v1/models')).status, 200);
  const tokenLimit = await call('/v1/models');
  assert.equal(tokenLimit.status, 429);
  assert.equal(tokenLimit.headers.get('retry-after'), '1');
  assert.equal((await tokenLimit.json()).error.code, 'rate_limit_exceeded');
  assert.equal((await call('/v1/models', undefined, 'bob')).status, 200);
  assert.equal((await call('/v1/models', undefined, 'charlie')).status, 429);
  time = 1000;
  assert.equal((await call('/v1/models')).status, 200);
});

test('streaming failures have normal HTTP errors before content and SSE errors after content', async t => {
  const { call } = await api(t, { generator: async (prompt, model, chunk) => {
    if (prompt === 'partial') chunk('some text');
    throw new ApiError('upstream_timeout', 'Generation timed out.', 504, { delivery: prompt === 'partial' ? 'unknown' : 'not_sent' });
  } });
  const early = await call('/v1/chat/completions', { stream: true, messages: message('early') });
  assert.equal(early.status, 504);
  assert.equal((await early.json()).error.delivery, 'not_sent');
  const partial = await call('/v1/chat/completions', { stream: true, messages: message('partial') });
  assert.equal(partial.status, 200);
  const body = await partial.text();
  assert.match(body, /some text/);
  assert.match(body, /"delivery":"unknown"/);
  assert.doesNotMatch(body, /\[DONE\]|"finish_reason":"stop"/);
});

test('split UTF-8 request chunks preserve Persian text', async t => {
  const { base } = await api(t);
  const body = Buffer.from(JSON.stringify({ messages: message('سلام') }));
  const position = body.indexOf(Buffer.from('س')) + 1;
  const result = await new Promise((resolve, reject) => {
    const request = http.request(base + '/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    request.on('error', reject);
    request.write(body.subarray(0, position));
    setImmediate(() => request.end(body.subarray(position)));
  });
  assert.equal(result.choices[0].message.content, 'answer: سلام');
});
