import { MODELS } from './gapgpt-transport.js';

// One page and one FIFO queue preserve the same conversation across API calls.
export function createConversation(page, { timeout = 300000, pollInterval = 100 } = {}) {
  let tail = Promise.resolve();
  let busy = false;
  let queued = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function send(prompt, model, onChunk) {
    if (page.isClosed()) throw new Error('The conversation tab was closed. Restart the server to open a new chat.');
    try {
      const input = page.locator('.composer-textarea textarea, textarea.bidi-textarea').first();
      await input.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {
        throw new Error('GapGPT composer unavailable. Sign in to GapGPT in the server browser.');
      });
      await input.fill(prompt);
      const sendButton = page.locator('button.submit-btn-v2')
        .filter({ has: page.locator('i', { hasText: 'arrow_upward' }) }).first();
      // After a timeout, the previous generation may still be running on the site.
      // Wait for its stop button to become a send button before arming another request.
      await sendButton.waitFor({ state: 'visible', timeout });
      await page.evaluate(target => window.__gapgptCapture.arm(target), model.target);
      await sendButton.click({ timeout: 15000 });
      const started = Date.now();
      let emitted = '';
      while (Date.now() - started < timeout) {
        const state = await page.evaluate(() => ({ ...window.__gapgptCapture.state }));
        if (state.error) throw new Error(state.error);
        if (!state.sent && Date.now() - started > 15000) {
          throw new Error('GapGPT did not send the message. Check login, subscription, and dialogs in the server browser.');
        }
        if (onChunk && state.text.startsWith(emitted) && state.text.length > emitted.length) {
          onChunk(state.text.slice(emitted.length));
          emitted = state.text;
        }
        if (state.complete) {
          if (!state.text.trim()) throw new Error('GapGPT completed without a text response');
          if (onChunk && state.text !== emitted) throw new Error('GapGPT revised already streamed text; retry with stream=false');
          return state.text;
        }
        await sleep(pollInterval);
      }
      throw new Error('GapGPT generation timed out before completion');
    } finally {
      // Reset capture only. Keep the document, socket, and conversation in place.
      await page.evaluate(() => window.__gapgptCapture?.disarm()).catch(() => {});
    }
  }

  return {
    get busy() { return busy; },
    get queued() { return queued; },
    generate(prompt, modelId = 'gapgpt', onChunk = null) {
      const model = MODELS.find(m => m.id === modelId);
      if (!model) return Promise.reject(new Error(`Unsupported model: ${modelId}`));
      queued++;
      const result = tail.then(async () => {
        queued--;
        busy = true;
        try { return await send(prompt, model, onChunk); }
        finally { busy = false; }
      });
      tail = result.catch(() => {}); // An error must not block later requests.
      return result;
    }
  };
}
