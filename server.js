/**
 * GapGPT API Server - Persistent Conversation
 * OpenAI-compatible endpoint for GapGPT web interface
 * Requests are queued and appended to the same browser conversation
 */

import http from 'http';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { bridgeSource, MODELS } from './gapgpt-transport.js';
import { createConversation } from './conversation.js';

// ==================== Configuration ====================
const PORT = process.env.PORT || 3003;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'sk-chatgpt';
const TARGET_URL = 'https://gapgpt.app/chat/';
const HEADLESS = process.env.HEADLESS === 'true';
const STATE_FILE = path.join(process.cwd(), 'browser-state.json');
const GENERATION_TIMEOUT = Math.max(1000, Number(process.env.GENERATION_TIMEOUT) || 300000);

// ==================== Globals ====================
let browser = null;
let context = null;
let chatPage = null;
let conversation = null;
let isInitializing = false;

// ==================== Logger ====================
function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' | ' + JSON.stringify(meta) : '';
  console.log(`${ts} [${level}] ${msg}${metaStr}`);
}

// ==================== Browser Init ====================
async function initBrowser() {
  if (browser || isInitializing) return;
  isInitializing = true;
  
  log('INFO', 'Starting browser...');
  browser = await chromium.launch({ 
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled']
  });
  
  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  
  if (fs.existsSync(STATE_FILE)) {
    log('INFO', 'Loading saved browser state...');
    contextOptions.storageState = STATE_FILE;
  }

  context = await browser.newContext(contextOptions);
  await context.addInitScript({ content: bridgeSource });
  
  chatPage = await context.newPage();
  log('INFO', 'Navigating to GapGPT...');
  await chatPage.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  conversation = createConversation(chatPage, { timeout: GENERATION_TIMEOUT });
  setInterval(saveState, 30000);
  isInitializing = false;
  log('INFO', 'Browser ready. Requests continue the same chat in arrival order.');
}

async function saveState() {
  if (!context) return;
  try {
    await context.storageState({ path: STATE_FILE });
  } catch (e) {
    log('WARN', 'Failed to save state', { error: e.message });
  }
}

async function generate(prompt, modelId = 'gapgpt', onChunk = null) {
  if (!conversation) throw new Error('Browser not initialized');
  return conversation.generate(prompt, modelId, onChunk);
}

// ==================== HTTP Server ====================
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;
  const token = auth.replace('Bearer ', '');
  return token === AUTH_TOKEN;
}

export async function handleRequest(req, res, generator = generate) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
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
      browser: !!browser,
      totalPages: chatPage && !chatPage.isClosed() ? 1 : 0,
      busyPages: conversation?.busy ? 1 : 0,
      maxPages: 1,
      queuedRequests: conversation?.queued || 0,
      mode: 'persistent'
    });
  }

  // Models list
  if (pathname === '/v1/models' && req.method === 'GET') {
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });
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
    if (!checkAuth(req)) return sendJson(res, 401, { error: 'Unauthorized' });

    try {
      const body = await parseBody(req);
      const { model = 'gapgpt', messages = [], stream = false } = body || {};
      if (!MODELS.some(m => m.id === model)) return sendJson(res, 400, { error: `Unsupported model: ${model}` });
      
      if (!Array.isArray(messages) || !messages.length) {
        return sendJson(res, 400, { error: 'No messages provided' });
      }

      const lastUserMsg = messages.filter(m => m?.role === 'user').pop();
      if (!lastUserMsg) {
        return sendJson(res, 400, { error: 'No user message found' });
      }
      
      if (typeof lastUserMsg.content !== 'string' && (!Array.isArray(lastUserMsg.content) || lastUserMsg.content.some(c => c?.type !== 'text' || typeof c.text !== 'string'))) {
        return sendJson(res, 400, { error: 'Only text messages are supported' });
      }
      const prompt = typeof lastUserMsg.content === 'string' 
        ? lastUserMsg.content 
        : lastUserMsg.content.map(c => c.text || '').join('\n');

      if (!prompt.trim()) return sendJson(res, 400, { error: 'Empty user message' });
      const responseId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const onChunk = (chunk) => {
          const chunkData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        };

        try {
          await generator(prompt, model, onChunk);
          
          const finishData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(finishData)}\n\n`);
          res.write('data: [DONE]\n\n');
          
        } catch (e) {
          res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        }
        
        return res.end();
        
      } else {
        const text = await generator(prompt, model);

        return sendJson(res, 200, {
          id: responseId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
      }

    } catch (e) {
      log('ERROR', 'Generation failed', { error: e.message });
      return sendJson(res, e.message === 'Invalid JSON' ? 400 : 500, { error: e.message });
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ==================== Main ====================
async function main() {
  await initBrowser();
  
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    log('INFO', `GapGPT Server running on port ${PORT}`);
    log('INFO', 'Bearer token authentication enabled');
    log('INFO', 'Endpoints:');
    log('INFO', '  GET  /health               - Health check');
    log('INFO', '  GET  /v1/models            - List models');
    log('INFO', '  POST /v1/chat/completions  - Chat (persistent conversation, requests queued)');
  });

  process.on('SIGINT', async () => {
    log('INFO', 'Shutting down...');
    if (context) await saveState();
    if (browser) await browser.close();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e => {
  log('ERROR', 'Startup failed', { error: e.message });
  process.exit(1);
});
