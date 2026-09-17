// The page's public socket protocol: new_message -> ack_new_message,
// followed by text_response_chunk and new_message snapshots.
// Self-contained so the same reducer can run in Node tests and an init script.
export function createCapture() {
  let armed = false, requestId, messageToken, chatToken;
  let blocks = [], pending = [];
  const state = { text: '', complete: false, error: null, sent: false, chatToken: null };
  const render = () => {
    state.text = blocks.filter(b => b.type === 'text').map(b => b.content || '').join('\n\n');
  };
  function accept(packet) {
    const data = packet?.data;
    if (!armed || !state.sent || !data || state.complete) return;
    if (packet.event === 'ack_new_message') {
      if (packet.rid !== requestId) return;
      if (messageToken) return; // Retransmitted acknowledgement after transport fallback.
      if (data.status !== 'ok') {
        state.error = `GapGPT: ${data.status || 'error'}${typeof data.message === 'string' ? ` (${data.message})` : ''}`;
        state.complete = true;
        return;
      }
      messageToken = data.message?.token;
      chatToken = data.message?.chat_token || data.chat?.token;
      state.chatToken = chatToken || null;
      if (!messageToken) {
        state.error = 'GapGPT acknowledgement has no message token';
        state.complete = true;
        return;
      }
      if (Array.isArray(data.message.response)) blocks = data.message.response.map(b => ({ ...b }));
      render();
      const queued = pending;
      pending = [];
      queued.forEach(accept);
      if (data.message.status === 'completed') state.complete = true;
      return;
    }
    if (!['new_message', 'text_response_chunk'].includes(packet.event)) return;
    if (!messageToken) {
      if (pending.length < 1000) pending.push(packet);
      return;
    }
    if (packet.event === 'new_message') {
      const message = data.message;
      if (message?.token !== messageToken || (chatToken && message.chat_token !== chatToken)) return;
      if (Array.isArray(message.response)) blocks = message.response.map(b => ({ ...b }));
      render();
      if (message.status === 'completed') state.complete = true;
      if (['error', 'failed'].includes(message.status)) {
        state.error = 'GapGPT generation failed';
        state.complete = true;
      }
    } else {
      if (data.mtoken !== messageToken || (chatToken && data.token !== chatToken)) return;
      const block = blocks.find(b => b.block_id === data.block_id);
      // Unknown blocks are recovered from the next full snapshot. Never expose reasoning.
      if (!block || block.type !== 'text' || typeof data.text !== 'string') return;
      const index = Number(data.start_ind);
      if (!Number.isInteger(index) || index < 0) return;
      const chars = Array.from(block.content || '');
      if (index > chars.length) return; // Wait for a snapshot instead of inventing missing text.
      block.content = chars.slice(0, index).join('') + data.text;
      render();
    }
  }
  return {
    state,
    arm(model) {
      armed = true;
      this.model = model;
      requestId = messageToken = chatToken = undefined;
      blocks = [];
      pending = [];
      Object.assign(state, { text: '', complete: false, error: null, sent: false, chatToken: null });
    },
    disarm() { armed = false; pending = []; },
    outgoing(raw) {
      if (!armed || typeof raw !== 'string') return raw;
      let packet;
      try { packet = JSON.parse(raw); } catch { return raw; }
      if (packet.event !== 'new_message' || packet.data?.action?.type !== 'text_message') return raw;
      if (state.sent && packet.rid !== requestId) return raw;
      state.sent = true;
      requestId = packet.rid;
      if (this.model) {
        packet.data.chat_model = this.model;
        return JSON.stringify(packet);
      }
      return raw;
    },
    incoming(raw) {
      try { accept(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { /* Unrelated frames. */ }
    }
  };
}

export function installGapGPTBridge(createCapture) {
  const capture = createCapture();
  window.__gapgptCapture = capture;
  const isTransport = value => {
    try {
      const url = new URL(value, location.href);
      return ['gapgpt.app', 'ws.gapgpt.app'].includes(url.hostname) && url.pathname.startsWith('/ws/salam');
    } catch { return false; }
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      this.__gapgptTransport = isTransport(args[0]);
      if (this.__gapgptTransport) this.addEventListener('message', e => capture.incoming(e.data));
    }
    send(data) { return super.send(this.__gapgptTransport ? capture.outgoing(data) : data); }
  };
  const NativeEventSource = window.EventSource;
  if (NativeEventSource) window.EventSource = class extends NativeEventSource {
    constructor(...args) {
      super(...args);
      if (isTransport(args[0])) this.addEventListener('message', e => capture.incoming(e.data));
    }
  };
  const originalFetch = window.fetch;
  window.fetch = async function(input, options) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (!isTransport(url) || !new URL(url, location.href).pathname.endsWith('/events')) {
      return originalFetch.call(this, input, options);
    }
    if (typeof options?.body === 'string') options = { ...options, body: capture.outgoing(options.body) };
    else if (input instanceof Request && !options?.body && input.method === 'POST') {
      input = new Request(input, { body: capture.outgoing(await input.clone().text()) });
    }
    const response = await originalFetch.call(this, input, options);
    response.clone().json().then(body => {
      for (const event of body.events || []) capture.incoming(event);
    }).catch(() => {});
    return response;
  };
}

export const bridgeSource = `(() => { const createCapture = ${createCapture.toString()}; (${installGapGPTBridge.toString()})(createCapture); })();`;

export const MODELS = [
  { id: 'gapgpt', target: null }, // Use the model selected by the website/account.
  { id: 'gpt-5.1', target: 'A-GPT-5' },
  { id: 'gpt-4.1', target: 'A-GPT-4.1' },
  { id: 'gpt-4o-mini', target: 'A-GPT4O-MINI' },
];
