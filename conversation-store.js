import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export const digest = value => createHash('sha256').update(value).digest('hex');

// One server process owns this file. Replace atomically; never overwrite corrupt data.
export function createConversationStore(file = null) {
  const records = new Map();
  if (file && fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.conversations)) throw new Error('Invalid conversation store');
    for (const record of data.conversations) {
      if (!record || !/^[a-f0-9]{64}$/.test(record.owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
          typeof record.id !== 'string' || typeof record.attempted !== 'boolean' ||
          !(record.url === null || typeof record.url === 'string') ||
          !(record.chatToken === null || typeof record.chatToken === 'string') ||
          typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' ||
          !record.requests || typeof record.requests !== 'object' || Array.isArray(record.requests)) {
        throw new Error('Invalid conversation record');
      }
      for (const [key, request] of Object.entries(record.requests)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !request || !/^[a-f0-9]{64}$/.test(request.fingerprint) ||
            !['pending', 'done'].includes(request.status) || !Number.isFinite(request.createdAt) ||
            (request.status === 'done' && typeof request.text !== 'string')) throw new Error('Invalid saved request');
      }
      if (records.has(`${record.owner}:${record.id}`)) throw new Error('Duplicate conversation record');
      records.set(`${record.owner}:${record.id}`, record);
    }
  }
  function flush() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, conversations: [...records.values()] }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch {
      throw new ApiError('storage_unavailable', 'Conversation state could not be saved. Check disk space and permissions.', 503);
    }
  }
  return {
    records, flush,
    get(owner, id) { return records.get(`${owner}:${id}`); },
    create(owner, id) {
      const key = `${owner}:${id}`;
      if (records.has(key)) return records.get(key);
      const now = new Date().toISOString();
      const record = { owner, id, url: null, chatToken: null, attempted: false, createdAt: now, updatedAt: now, requests: {} };
      records.set(key, record);
      try { flush(); } catch (error) { records.delete(key); throw error; }
      return record;
    }
  };
}
