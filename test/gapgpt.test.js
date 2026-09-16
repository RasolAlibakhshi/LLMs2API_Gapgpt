import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { createCapture, bridgeSource } from '../gapgpt-transport.js';
import { handleRequest } from '../server.js';

const outgoing = (rid = 42) => JSON.stringify({ event: 'new_message', rid, data: { action: { type: 'text_message' }, chat_model: 'A-GAP' } });
const snapshot = (response, status = 'processing', token = 'm1') => ({ event: 'new_message', data: { message: { token, chat_token: 'c1', response, status } } });
const block = content => ({ block_id: 'b1', type: 'text', content });
const ack = (rid = 42) => ({ event: 'ack_new_message', rid, data: { status: 'ok', message: { token: 'm1', chat_token: 'c1', response: [block('')] } } });
function active() {
  const c = createCapture(); c.arm('A-GPT-5'); c.outgoing(outgoing()); c.incoming(ack()); return c;
}

test('correlates acknowledgements and excludes other requests and reasoning', () => {
  const c = createCapture(); c.arm('A-GPT-5');
  assert.equal(JSON.parse(c.outgoing(outgoing())).data.chat_model, 'A-GPT-5');
  c.incoming(ack(99));
  assert.equal(c.state.text, '');
  c.incoming(ack());
  c.incoming(snapshot([block('unrelated')], 'completed', 'other'));
  c.incoming(snapshot([{ type: 'reasoning', content: 'private', block_id: 'r' }, block('سلام')]));
  assert.equal(c.state.text, 'سلام');
  assert.equal(c.state.complete, false);
});

test('Unicode offsets, retries, duplicate acknowledgement, and final snapshots', () => {
  const c = active(); c.incoming(snapshot([block('سلام 🌍')]));
  const chunk = { event: 'text_response_chunk', data: { token: 'c1', mtoken: 'm1', block_id: 'b1', start_ind: 6, text: ' دنیا' } };
  c.incoming(chunk); c.incoming(chunk); c.incoming(ack());
  assert.equal(c.state.text, 'سلام 🌍 دنیا');
  c.incoming(snapshot([block('سلام 🌍 دنیا!')], 'completed'));
  assert.equal(c.state.text, 'سلام 🌍 دنیا!');
  assert.equal(c.state.complete, true);
});

test('events arriving before acknowledgement are replayed; missing offsets do not fabricate text', () => {
  const c = createCapture(); c.arm(null); c.outgoing(outgoing());
  c.incoming(snapshot([block('answer')], 'completed'));
  c.incoming(ack());
  assert.equal(c.state.text, 'answer'); assert.equal(c.state.complete, true);
  const d = active();
  d.incoming({ event: 'text_response_chunk', data: { token: 'c1', mtoken: 'm1', block_id: 'b1', start_ind: 100, text: 'tail' } });
  assert.equal(d.state.text, '');
});

test('quota rejection terminates promptly and separate captures remain isolated', () => {
  const a = active(), b = createCapture(); b.arm(null); b.outgoing(outgoing(99));
  b.incoming({ event: 'ack_new_message', rid: 99, data: { status: 'sub_upgrade', message: 'message_limit' } });
  assert.match(b.state.error, /message_limit/); assert.equal(b.state.complete, true);
  assert.equal(a.state.error, null);
});

test('init script observes WebSocket, SSE, and fallback POST events without altering other traffic', async () => {
  class Socket extends EventTarget { send(data) { this.lastSent = data; } }
  class Source extends EventTarget {}
  let posted;
  const window = { WebSocket: Socket, EventSource: Source, fetch: async (input, options) => {
    posted = options?.body ?? await input.text();
    return new Response(JSON.stringify({ events: [ack()] }));
  } };
  vm.runInNewContext(bridgeSource, { window, location: { href: 'https://gapgpt.app/chat/' }, URL, Request });
  const c = window.__gapgptCapture; c.arm('A-GPT-5');
  const unrelated = new window.WebSocket('wss://example.org/'); unrelated.send(outgoing());
  assert.equal(unrelated.lastSent, outgoing()); assert.equal(c.state.sent, false);
  const ws = new window.WebSocket('wss://ws.gapgpt.app/ws/salam'); ws.send(outgoing());
  assert.equal(JSON.parse(ws.lastSent).data.chat_model, 'A-GPT-5');
  await window.fetch('https://gapgpt.app/ws/salam/events', { method: 'POST', body: outgoing() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(posted).data.chat_model, 'A-GPT-5');
  ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(snapshot([block('hello')])) }));
  assert.equal(c.state.text, 'hello');
  const sse = new window.EventSource('https://gapgpt.app/ws/salam/sse?version=96');
  sse.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(snapshot([block('hello world')], 'completed')) }));
  assert.equal(c.state.text, 'hello world'); assert.equal(c.state.complete, true);
});

test('HTTP JSON, streaming, authentication, validation and error responses', async t => {
  const server = http.createServer((req, res) => handleRequest(req, res, async (prompt, model, chunk) => {
    if (prompt === 'fail') throw new Error('GapGPT: message_limit');
    chunk?.('سلام'); chunk?.(' دنیا'); return 'سلام دنیا';
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${process.env.AUTH_TOKEN || 'sk-chatgpt'}`, 'Content-Type': 'application/json' };
  const post = body => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/v1/models')).status, 401);
  assert.equal((await (await fetch(base + '/v1/models', { headers })).json()).data[0].id, 'gapgpt');
  const messages = [{ role: 'user', content: 'hello' }];
  assert.equal((await (await post({ messages })).json()).choices[0].message.content, 'سلام دنیا');
  const stream = await (await post({ messages, stream: true })).text();
  assert.match(stream, /سلام/); assert.match(stream, /دنیا/); assert.match(stream, /data: \[DONE\]/);
  assert.equal((await post({ messages, model: 'unknown' })).status, 400);
  assert.equal((await post({ messages: 'wrong' })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: 'fail' }] })).status, 500);
  const failure = await (await post({ stream: true, messages: [{ role: 'user', content: 'fail' }] })).text();
  assert.match(failure, /message_limit/); assert.doesNotMatch(failure, /"finish_reason":"stop"/);
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: '{' })).status, 400);
});
