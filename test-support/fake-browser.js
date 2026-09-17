import vm from 'node:vm';
import { createCapture } from '../gapgpt-transport.js';

export const chatUrl = 'https://example.test/chat/';

// A fake remote site retains chat history even when all client pages are closed.
export function fakeSite({ beforeNavigate, afterClick } = {}) {
  const chats = new Map(), pages = [], navigations = [];
  let sequence = 0, peak = 0;
  const context = {
    async newPage() {
      let currentUrl = 'about:blank', closed = false, prompt = '', message = 0;
      const capture = createCapture();
      const sandbox = vm.createContext({ window: { __gapgptCapture: capture } });
      const input = {
        first() { return this; }, async waitFor() {}, async fill(value) { prompt = value; }
      };
      const button = {
        first() { return this; }, filter() { return this; }, async waitFor() {},
        async click() {
          const rid = ++message;
          capture.outgoing(JSON.stringify({ event: 'new_message', rid, data: { action: { type: 'text_message' } } }));
          page.sent.push(prompt);
          if (prompt === 'disconnect') { closed = true; throw new Error('Browser disconnected'); }
          if (prompt === 'quota') {
            capture.incoming({ event: 'ack_new_message', rid, data: { status: 'sub_upgrade', message: 'message_limit' } });
            return;
          }
          if (currentUrl === chatUrl) {
            currentUrl = `${chatUrl}chat-${++sequence}`;
            chats.set(currentUrl, []);
          }
          const history = chats.get(currentUrl);
          if (!history) throw new Error('Missing fake remote chat');
          history.push(prompt);
          const token = `message-${rid}`, chatToken = currentUrl.slice(chatUrl.length);
          capture.incoming({ event: 'ack_new_message', rid, data: { status: 'ok', message: { token, chat_token: chatToken, response: [] } } });
          await afterClick?.(page, prompt);
          if (prompt === 'stall') return;
          capture.incoming({ event: 'new_message', data: { message: {
            token, chat_token: chatToken, status: 'completed',
            response: [{ type: 'text', block_id: 'answer', content: `answer: ${prompt}` }]
          } } });
        }
      };
      const page = {
        sent: [],
        url: () => currentUrl,
        isClosed: () => closed,
        async close() { closed = true; },
        async goto(url) {
          navigations.push(url);
          await beforeNavigate?.(page, url);
          currentUrl = url;
        },
        redirect(url) { currentUrl = url; },
        locator(selector) { return selector.includes('textarea') ? input : button; },
        async evaluate(fn, arg) {
          if (closed) throw new Error('Page closed');
          sandbox.arg = arg;
          return vm.runInContext(`(${fn.toString()})(arg)`, sandbox);
        }
      };
      pages.push(page);
      peak = Math.max(peak, pages.filter(p => !p.isClosed()).length);
      return page;
    }
  };
  return { context, pages, chats, navigations, get peak() { return peak; } };
}

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
