import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserSession } from '../browser-session.js';

test('concurrent browser recovery launches once and restores saved login state', async t => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-browser-'));
  assert.equal(path.dirname(directory), process.cwd());
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json'), browsers = [], options = [];
  let scriptCount = 0, loginTabs = 0;
  const session = createBrowserSession({ stateFile: file, url: 'https://example.test/chat/', bridgeSource: 'bridge',
    async launch() {
      const browser = new EventEmitter();
      let connected = true;
      browser.isConnected = () => connected;
      browser.close = async () => { connected = false; browser.emit('disconnected'); };
      browser.newContext = async config => {
        options.push(config);
        const context = new EventEmitter();
        context.addInitScript = async ({ content }) => { assert.equal(content, 'bridge'); scriptCount++; };
        context.newPage = async () => { loginTabs++; return { async goto() {} }; };
        context.storageState = async () => ({ cookies: [], origins: [] });
        return context;
      };
      browsers.push(browser);
      return browser;
    }
  });
  const [a, b] = await Promise.all([session.getContext(), session.getContext()]);
  assert.equal(a, b);
  assert.equal(browsers.length, 1);
  await session.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { cookies: [], origins: [] });
  await browsers[0].close();
  assert.equal(session.connected, false);
  const [c, d] = await Promise.all([session.getContext(), session.getContext()]);
  assert.equal(c, d);
  assert.notEqual(c, a);
  assert.equal(options[1].storageState, file);
  assert.equal(scriptCount, 2);
  assert.equal(loginTabs, 2);
  await session.close();
  await assert.rejects(session.getContext(), { code: 'server_stopping' });
});

test('failed launch is not cached forever', async () => {
  let attempts = 0;
  const session = createBrowserSession({
    stateFile: 'unused-test-state.json', url: 'https://example.test/chat/', bridgeSource: '',
    async launch() { attempts++; throw new Error('launch failed'); }
  });
  await assert.rejects(session.getContext(), /launch failed/);
  await assert.rejects(session.getContext(), /launch failed/);
  assert.equal(attempts, 2);
});
