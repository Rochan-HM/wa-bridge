'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { createServer, renderQrPng } = require('../server');
const { HttpError } = require('../format');

function fakeBridge(overrides = {}) {
  return {
    getStatus() {
      return { status: 'starting', phone: '15551234567', updatedAt: '2026-01-01T00:00:00.000Z' };
    },
    async pair(phone) {
      return { pairingCode: 'ABCD1234', phone: phone || '15551234567' };
    },
    async send({ to, text }) {
      return { ok: true, queued: false, jid: `${to}@s.whatsapp.net`, msgId: 'mid', text };
    },
    async logout() {
      return { ok: true };
    },
    ...overrides,
  };
}

async function withServer(bridge, fn, env = { API_TOKEN: 'secret' }) {
  const server = createServer(bridge, env);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await fn(port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function json(port, path, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
  const body = await res.json();
  return { status: res.status, body };
}

test('health, status, pair, and unknown routes', async () => {
  let paired = null;
  await withServer(fakeBridge({
    async pair(phone) {
      paired = phone;
      return { pairingCode: 'ABCD1234', phone: phone || '15551234567' };
    },
  }), async (port) => {
    const health = await json(port, '/health');
    assert.deepEqual(health.body, { ok: true });
    assert.equal(health.status, 200);

    const status = await json(port, '/status');
    assert.equal(status.body.status, 'starting');
    assert.equal(status.body.phone, '15551234567');
    assert.equal(status.body.pairingCode, undefined);

    const missing = await json(port, '/pair', { method: 'POST' });
    assert.equal(missing.status, 200);
    assert.equal(paired, undefined);
    assert.equal(missing.body.phone, '15551234567');

    const pair = await json(port, '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '15557654321' }),
    });
    assert.deepEqual(pair.body, { pairingCode: 'ABCD1234', phone: '15557654321' });
    assert.equal(paired, '15557654321');

    const missingRoute = await json(port, '/nope');
    assert.equal(missingRoute.status, 404);
  });
});

test('send requires the bearer token and queues when asked', async () => {
  const sent = [];
  await withServer(fakeBridge({
    async send(body) {
      sent.push(body);
      return { ok: true, queued: true, jid: 'abc@lid', id: 'job1' };
    },
  }), async (port) => {
    const denied = await json(port, '/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'abc@lid', text: 'hi' }),
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: 'unauthorized' });

    const wrong = await json(port, '/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer nope',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: 'abc@lid', text: 'hi' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(sent.length, 0);

    const ok = await json(port, '/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: 'abc@lid', text: 'hi' }),
    });
    assert.equal(ok.status, 202);
    assert.deepEqual(ok.body, { ok: true, queued: true, jid: 'abc@lid', id: 'job1' });
    assert.deepEqual(sent, [{ to: 'abc@lid', text: 'hi' }]);
  });
});

test('send is unauthorized when API_TOKEN is unset', async () => {
  await withServer(fakeBridge(), async (port) => {
    const denied = await json(port, '/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: '15551234567', text: 'hi' }),
    });
    assert.equal(denied.status, 401);
  }, {});
});

test('bridge errors keep their status and invalid JSON is 400', async () => {
  await withServer(fakeBridge({
    async pair() {
      throw new HttpError(409, 'already connected');
    },
    async logout() {
      throw new Error('boom');
    },
  }), async (port) => {
    const conflict = await json(port, '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '15551234567' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'already connected');

    const bad = await json(port, '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(bad.status, 400);

    const fatal = await json(port, '/logout', { method: 'POST' });
    assert.equal(fatal.status, 500);
    assert.equal(fatal.body.error, 'internal error');
  });
});

test('qr routes are unauthenticated and return a png plus json', async () => {
  const payload = 'https://wa.me/settings/linked_devices#ref,noise,identity,adv,1';
  await withServer(fakeBridge({
    getQr() {
      return {
        qr: payload,
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'waiting-for-pairing-code',
      };
    },
  }), async (port) => {
    const info = await json(port, '/qr.json');
    assert.equal(info.status, 200);
    assert.deepEqual(info.body, {
      qr: payload,
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'waiting-for-pairing-code',
    });

    const pngRes = await fetch(`http://127.0.0.1:${port}/qr`);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get('content-type'), 'image/png');
    assert.equal(pngRes.headers.get('cache-control'), 'no-store');
    const png = Buffer.from(await pngRes.arrayBuffer());
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(png, await renderQrPng(payload));
  });
});

test('qr routes report when no code is ready or the session is already linked', async () => {
  let calls = 0;
  await withServer(fakeBridge({
    getQr() {
      calls += 1;
      if (calls <= 2) throw new HttpError(404, 'qr not ready');
      throw new HttpError(409, 'already connected');
    },
  }), async (port) => {
    const missing = await json(port, '/qr');
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'qr not ready' });

    const missingJson = await json(port, '/qr.json');
    assert.equal(missingJson.status, 404);

    const linked = await json(port, '/qr');
    assert.equal(linked.status, 409);
    assert.equal(linked.body.error, 'already connected');
  });
});
