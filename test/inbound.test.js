'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { handleUpsert, postWebhook } = require('../inbound');

function message(text) {
  return {
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm1' },
    pushName: 'Ada',
    messageTimestamp: 1_700_000_000,
    message: { conversation: text },
  };
}

test('handleUpsert appends inbox and posts the webhook with the raw auth header', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-inbox-'));
  const inboxPath = path.join(dir, 'inbox.jsonl');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const delivered = await handleUpsert(
    { type: 'notify', messages: [message('hello'), { key: { fromMe: true }, message: { conversation: 'skip' } }] },
    {
      inboxPath,
      webhookUrl: 'https://hooks.example/wa',
      webhookAuth: 'Bearer hook-secret',
      fetchImpl,
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.example/wa');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer hook-secret');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.source, 'whatsapp');
  assert.equal(body.entry.text, 'hello');
  assert.equal(body.entry.chatId, '15551234567@s.whatsapp.net');
  const lines = (await fs.readFile(inboxPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, 'hello');
  assert.equal(JSON.parse(lines[0]).source, undefined);
});

test('handleUpsert ignores append history and continues when the webhook fails', async () => {
  const fetchImpl = async () => {
    throw new Error('down');
  };
  const warnings = [];
  const delivered = await handleUpsert(
    { type: 'notify', messages: [message('hello')] },
    {
      webhookUrl: 'https://hooks.example/wa',
      fetchImpl,
      log: { info() {}, warn(obj, msg) { warnings.push(msg); } },
    }
  );
  assert.equal(delivered.length, 1);
  assert.ok(warnings.includes('webhook post failed'));

  const skipped = await handleUpsert(
    { type: 'append', messages: [message('old')] },
    { fetchImpl, log: { info() {}, warn() {} } }
  );
  assert.deepEqual(skipped, []);
});

test('postWebhook rejects non-2xx responses', async () => {
  await assert.rejects(
    () => postWebhook({
      url: 'https://hooks.example/wa',
      authHeader: '',
      payload: { source: 'whatsapp', entry: {} },
      fetchImpl: async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }),
    }),
    /webhook status 500/
  );
});
