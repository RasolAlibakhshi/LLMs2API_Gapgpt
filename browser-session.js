import fs from 'node:fs';
import { ApiError } from './errors.js';

// Single-flight browser recovery: concurrent callers share the same launch.
export function createBrowserSession({ launch, stateFile, url, bridgeSource, headless = false }) {
  let browser = null, context = null, initializing = null, stopped = false;
  return {
    async getContext() {
      if (stopped) throw new ApiError('server_stopping', 'Browser is shutting down.', 503);
      if (browser?.isConnected() && context) return context;
      if (initializing) return initializing;
      initializing = (async () => {
        let nextBrowser;
        try {
          if (browser?.isConnected()) await browser.close();
          nextBrowser = await launch({ headless, args: ['--disable-blink-features=AutomationControlled'] });
          const options = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          };
          if (fs.existsSync(stateFile)) options.storageState = stateFile;
          const nextContext = await nextBrowser.newContext(options);
          await nextContext.addInitScript({ content: bridgeSource });
          const loginPage = await nextContext.newPage();
          await loginPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
          browser = nextBrowser;
          context = nextContext;
          nextBrowser.on('disconnected', () => {
            if (browser === nextBrowser) { browser = null; context = null; }
          });
          nextContext.on('close', () => { if (context === nextContext) context = null; });
          return nextContext;
        } catch (error) {
          await nextBrowser?.close().catch(() => {});
          throw error;
        }
      })();
      try { return await initializing; } finally { initializing = null; }
    },
    async save() {
      const current = context;
      if (!current) return;
      // Capture asynchronously, then replace synchronously so saves cannot interleave.
      const state = await current.storageState();
      const temporary = `${stateFile}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    },
    async close() {
      stopped = true;
      await initializing?.catch(() => {});
      if (browser) await browser.close();
      browser = null;
      context = null;
    },
    get connected() { return !!(browser?.isConnected() && context); }
  };
}
