/**
 * GapGPT API Server - Persistent Conversation
 * OpenAI-compatible endpoint for GapGPT web interface
 * Each bearer token has its own tab, conversation, and request queue
 */

import http from 'http';
import { chromium } from 'playwright';
import path from 'path';
import { pathToFileURL } from 'url';
import { bridgeSource, MODELS } from './gapgpt-transport.js';
import { createTokenConversations, validateConversationId } from './token-conversations.js';
import { createConversationStore } from './conversation-store.js';
import { createBrowserSession } from './browser-session.js';
import { ApiError, asApiError, errorBody } from './errors.js';
import { limits, createRateLimiter, positiveSetting } from './limits.js';
import { randomUUID } from 'node:crypto';

// ==================== Configuration ====================
const PORT = process.env.PORT || 3003;
const TARGET_URL = 'https://gapgpt.app/chat/';
const HEADLESS = process.env.HEADLESS === 'true';
const STATE_FILE = path.join(process.cwd(), 'browser-state.json');
const GENERATION_TIMEOUT = positiveSetting('GENERATION_TIMEOUT', 300000);

// ==================== Globals ====================
let conversations = null;
const browserSession = createBrowserSession({
  launch: options => chromium.launch(options), stateFile: STATE_FILE,
  url: TARGET_URL, bridgeSource, headless: HEADLESS
});
const rateLimiter = createRateLimiter({
  perToken: positiveSetting('REQUESTS_PER_MINUTE_PER_TOKEN', 60),
  global: positiveSetting('REQUESTS_PER_MINUTE_GLOBAL', 300)
});

// ==================== Logger ====================
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
  console.log(`${ts} [${level}] ${msg}${metaStr}`);
}

// ==================== Browser Init ====================
async function initBrowser() {
  const store = createConversationStore(path.join(process.cwd(), 'conversations.json'));
  await browserSession.getContext();
  conversations = createTokenConversations(() => browserSession.getContext(), {
    url: TARGET_URL, timeout: GENERATION_TIMEOUT, store, ...limits
  });
  log('INFO', 'Browser ready. Conversations are restored on demand.');
}

async function saveState() {
  try {
    await browserSession.save();
  } catch (e) {
    log('WARN', 'Failed to save state', { error: e.message });
  }
}

async function generate(prompt, modelId = 'gapgpt', onChunk = null, token, options) {
  if (!conversations) throw new Error('Browser not initialized');
  return conversations.generate(token, prompt, modelId, onChunk, options);
}

// ==================== HTTP Server ====================
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, exceeded = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!exceeded) {
          exceeded = true;
          chunks.length = 0;
          reject(new ApiError('body_too_large', `Request body exceeds ${maxBytes} bytes.`, 413));
        }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new ApiError('invalid_json', 'Invalid JSON', 400));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new ApiError('request_aborted', 'Request body was interrupted.', 400)));
  });
}

function conversationToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  return /^Bearer[ \t]+([^\s]{1,512})[ \t]*$/i.exec(auth)?.[1] || null;
}

export async function handleRequest(req, res, generator = generate, services = {}) {
  try { await dispatchRequest(req, res, generator, services); }
  catch (error) {
    const e = asApiError(error);
    if (e.status >= 500) log('ERROR', 'Request failed', { code: e.code, delivery: e.delivery });
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.end(`data: ${JSON.stringify(errorBody(e))}\n\n`);
    } else {
      if (e.status === 429) res.setHeader('Retry-After', String(e.retryAfter || 1));
      sendJson(res, e.status, errorBody(e));
    }
  }
}

async function dispatchRequest(req, res, generator, { manager = conversations, limiter = rateLimiter, requestLimits = limits } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
  res.setHeader('Access-Control-Expose-Headers', 'X-Conversation-Id, Retry-After');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/health') {
    return sendJson(res, 200, { 
      status: 'ok', 
      browser: browserSession.connected,
      ...(manager?.stats || { totalPages: 0, busyPages: 0, queuedRequests: 0 }),
      mode: 'persistent-per-conversation'
    });
  }

  const token = conversationToken(req);
  if (pathname.startsWith('/v1/')) {
    if (!token) throw new ApiError('token_required', 'A non-empty Bearer token of at most 512 characters is required.', 401);
    limiter.check(token);
  }

  if (pathname === '/v1/conversations' && ['GET', 'POST'].includes(req.method)) {
    if (!manager) throw new ApiError('browser_unavailable', 'Conversation service is unavailable.', 503);
    if (req.method === 'GET') return sendJson(res, 200, { object: 'list', data: manager.list(token) });
    const body = await parseBody(req, requestLimits.maxBodyBytes);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('invalid_body', 'Expected a JSON object.', 400);
    if (body.conversation_id !== undefined) validateConversationId(body.conversation_id);
    return sendJson(res, 201, manager.create(token, body.conversation_id));
  }

  // Models list
  if (pathname === '/v1/models' && req.method === 'GET') {
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'gapgpt'
      }))
    });
  }

  // Chat completions
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await parseBody(req, requestLimits.maxBodyBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('invalid_body', 'Expected a JSON object.', 400);
      const { model = 'gapgpt', messages = [], stream = false, conversation_id: conversationId = 'default' } = body;
      validateConversationId(conversationId);
      if (typeof stream !== 'boolean') throw new ApiError('invalid_stream', 'stream must be a boolean.', 400);
      const requestId = req.headers['idempotency-key'];
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[!-~]{1,128}$/.test(requestId))) {
        throw new ApiError('invalid_request_key', 'Idempotency-Key must contain 1–128 printable non-space ASCII characters.', 400);
      }
      if (!MODELS.some(m => m.id === model)) throw new ApiError('unsupported_model', 'Unsupported model.', 400);
      
      if (!Array.isArray(messages) || !messages.length) {
        throw new ApiError('invalid_messages', 'No messages provided.', 400);
      }

      const lastUserMsg = messages.filter(m => m?.role === 'user').pop();
      if (!lastUserMsg) {
        throw new ApiError('invalid_messages', 'No user message found.', 400);
      }
      
      if (typeof lastUserMsg.content !== 'string' && (!Array.isArray(lastUserMsg.content) || lastUserMsg.content.some(c => c?.type !== 'text' || typeof c.text !== 'string'))) {
        throw new ApiError('invalid_messages', 'Only text messages are supported.', 400);
      }
      const prompt = typeof lastUserMsg.content === 'string' 
        ? lastUserMsg.content 
        : lastUserMsg.content.map(c => c.text || '').join('\n');

      if (!prompt.trim()) throw new ApiError('invalid_messages', 'Empty user message.', 400);
      if (prompt.length > requestLimits.maxMessageChars) throw new ApiError('message_too_large', `Message exceeds ${requestLimits.maxMessageChars} characters.`, 413);
      res.setHeader('X-Conversation-Id', conversationId);
      const options = { conversationId, requestId };
      const responseId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        const startStream = () => { if (!res.headersSent && !res.destroyed) res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }); };

        const onChunk = (chunk) => {
          if (res.destroyed || res.writableEnded) return;
          startStream();
          const chunkData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            conversation_id: conversationId,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        };

          await generator(prompt, model, onChunk, token, options);
          if (res.destroyed || res.writableEnded) return;
          startStream();
          
          const finishData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            conversation_id: conversationId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(finishData)}\n\n`);
          res.write('data: [DONE]\n\n');
          
        
        return res.end();
        
      } else {
        const text = await generator(prompt, model, null, token, options);
        if (res.destroyed || res.writableEnded) return;

        return sendJson(res, 200, {
          id: responseId,
          object: 'chat.completion',
          created,
          model,
          conversation_id: conversationId,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }

  }

  throw new ApiError('not_found', 'Not found.', 404);
}

// ==================== Main ====================
async function main() {
  await initBrowser();
  const stateTimer = setInterval(saveState, 30000);
  const idleTimer = setInterval(() => conversations.sweep().catch(e => log('WARN', 'Idle tab cleanup failed', { code: asApiError(e).code })), Math.min(limits.idleMs, 30000));
  
  const server = http.createServer((req, res) => handleRequest(req, res));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.listen(PORT, () => {
    log('INFO', `GapGPT Server running on port ${PORT}`);
    log('INFO', 'Any non-empty Bearer token is accepted as a conversation identifier; fixed-token authentication is disabled');
    log('INFO', 'Endpoints:');
    log('INFO', '  GET  /health               - Health check');
    log('INFO', '  GET  /v1/models            - List models');
    log('INFO', '  GET/POST /v1/conversations - List or create conversations');
    log('INFO', '  POST /v1/chat/completions  - Chat (separate persistent conversation and queue per token)');
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', 'Shutting down...');
    clearInterval(stateTimer);
    clearInterval(idleTimer);
    server.close();
    const deadline = setTimeout(() => process.exit(1), 30000);
    deadline.unref();
    try {
      await conversations.shutdown();
      await saveState();
      await browserSession.close();
      process.exit(0);
    } catch (e) {
      log('ERROR', 'Shutdown failed', { code: asApiError(e).code });
      process.exit(1);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => {
  log('ERROR', 'Startup failed', { error: e.message });
  process.exit(1);
});
