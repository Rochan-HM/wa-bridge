'use strict';

const fs = require('fs/promises');
const path = require('path');
const { buildInbound } = require('./format');

let inboxChain = Promise.resolve();

function appendInbox(file, entry) {
  const write = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(entry) + '\n');
  };
  inboxChain = inboxChain.then(write, write);
  return inboxChain;
}

async function postWebhook({ url, authHeader, payload, fetchImpl, timeoutMs = 8000 }) {
  const headers = { 'content-type': 'application/json' };
  if (authHeader) headers.authorization = authHeader;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore body errors */
  }
  if (!res.ok) {
    const error = new Error(`webhook status ${res.status}`);
    error.statusCode = res.status;
    throw error;
  }
}

async function handleUpsert(upsert, deps) {
  if (!upsert || upsert.type !== 'notify') return [];
  const delivered = [];
  for (const msg of upsert.messages || []) {
    const payload = buildInbound(msg);
    if (!payload) continue;
    delivered.push(payload);
    if (deps.inboxPath) {
      try {
        await appendInbox(deps.inboxPath, payload.entry);
      } catch (err) {
        deps.log?.warn({ err: String(err) }, 'inbox append failed');
      }
    }
    deps.log?.info(
      { msgId: payload.entry.msgId, chatId: payload.entry.chatId, mediaType: payload.entry.mediaType },
      'inbound'
    );
    if (!deps.webhookUrl) continue;
    try {
      await postWebhook({
        url: deps.webhookUrl,
        authHeader: deps.webhookAuth || '',
        payload,
        fetchImpl: deps.fetchImpl || fetch,
      });
    } catch (err) {
      deps.log?.warn({ err: String(err), msgId: payload.entry.msgId }, 'webhook post failed');
    }
  }
  return delivered;
}

module.exports = {
  appendInbox,
  postWebhook,
  handleUpsert,
};
