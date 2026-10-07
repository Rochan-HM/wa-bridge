'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { createBridge } = require('../bridge');
const { createServer, renderQrPng } = require('../server');
const { HttpError } = require('../format');

const QR = 'https://wa.me/settings/linked_devices#ref1,noise,identity,adv,1';
const QR_NEXT = 'https://wa.me/settings/linked_devices#ref2,noise,identity,adv,1';

function fakeBaileys() {
  const sockets = [];
  const mod = {
    default() {
      const listeners = new Map();
      const sock = {
        authState: { creds: { registered: false } },
        user: { id: '15551234567:14@s.whatsapp.net' },
        ev: {
          on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
          },
          removeAllListeners() {
            listeners.clear();
          },
        },
        end() {},
        async logout() {},
        async requestPairingCode(phone) {
          sock.pairedPhone = phone;
          return 'ABCD1234';
        },
        emit(event, payload) {
          for (const fn of [...(listeners.get(event) || [])]) fn(payload);
        },
      };
      sockets.push(sock);
      return sock;
    },
    async useMultiFileAuthState() {
      return {
        state: { creds: { registered: false }, keys: {} },
        async saveCreds() {},
      };
    },
    async fetchLatestBaileysVersion() {
      return { version: [2, 3000, 101] };
    },
    makeCacheableSignalKeyStore(keys) {
      return keys;
    },
    isJidBroadcast() {
      return false;
    },
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  };
  return { mod, sockets };
}

async function withBridge(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-qr-'));
  const fake = fakeBaileys();
  const bridge = createBridge({
    env: {
      AUTH_DIR: path.join(root, 'auth'),
      INBOX_PATH: 'off',
      OUTBOX_PATH: path.join(root, 'outbox.jsonl'),
      WA_LOG_LEVEL: 'silent',
    },
    logger: pino({ level: 'silent' }),
    baileys: fake.mod,
  });
  try {
    await bridge.start();
    await fn(bridge, fake.sockets);
  } finally {
    await bridge.halt();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function assertQrHidden(status) {
  assert.equal(Object.hasOwn(status, 'qr'), false);
  assert.equal(typeof status.hasQr, 'boolean');
}

test('connection.update keeps the latest qr off /status and serves it over HTTP', async () => {
  await withBridge(async (bridge, sockets) => {
    const sock = sockets[0];
    assert.equal(bridge.getStatus().hasQr, false);
    assert.throws(
      () => bridge.getQr(),
      (err) => err instanceof HttpError && err.status === 404
    );

    sock.authState.creds.registered = true;
    sock.emit('connection.update', { qr: QR });
    assert.equal(bridge.getStatus().hasQr, false);

    sock.authState.creds.registered = false;
    sock.emit('connection.update', { qr: QR });
    assert.equal(bridge.getStatus().status, 'waiting-for-pairing-code');
    assert.equal(bridge.getStatus().hasQr, true);
    assertQrHidden(bridge.getStatus());
    assert.equal(bridge.getQr().qr, QR);

    sock.emit('connection.update', { connection: 'connecting', qr: undefined });
    assert.equal(bridge.getQr().qr, QR);

    sock.emit('connection.update', { qr: QR_NEXT });
    assert.equal(bridge.getQr().qr, QR_NEXT);

    const server = createServer(bridge, {});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address();
      const statusRes = await fetch(`http://127.0.0.1:${port}/status`);
      const status = await statusRes.json();
      assert.equal(status.hasQr, true);
      assert.equal(status.qr, undefined);

      const infoRes = await fetch(`http://127.0.0.1:${port}/qr.json`);
      assert.equal(infoRes.status, 200);
      const info = await infoRes.json();
      assert.equal(info.qr, QR_NEXT);
      assert.equal(info.status, 'waiting-for-pairing-code');
      assert.equal(typeof info.updatedAt, 'string');

      const pngRes = await fetch(`http://127.0.0.1:${port}/qr`);
      assert.equal(pngRes.status, 200);
      assert.equal(pngRes.headers.get('content-type'), 'image/png');
      assert.equal(pngRes.headers.get('cache-control'), 'no-store');
      const png = Buffer.from(await pngRes.arrayBuffer());
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.deepEqual(png, await renderQrPng(QR_NEXT));

      sock.authState.creds.registered = true;
      sock.emit('creds.update', {});
      assert.equal(bridge.getStatus().hasQr, false);
      const registered = await fetch(`http://127.0.0.1:${port}/qr`);
      assert.equal(registered.status, 409);

      sock.authState.creds.registered = false;
      sock.emit('creds.update', {});
      sock.emit('connection.update', { qr: QR });
      sock.emit('connection.update', { isNewLogin: true, qr: undefined });
      assert.equal(bridge.getStatus().hasQr, false);

      sock.emit('connection.update', { qr: QR });
      sock.emit('connection.update', { connection: 'open' });
      const linked = await fetch(`http://127.0.0.1:${port}/qr`);
      assert.equal(linked.status, 409);
      const linkedStatus = await fetch(`http://127.0.0.1:${port}/status`).then((res) => res.json());
      assert.equal(linkedStatus.status, 'connected');
      assert.equal(linkedStatus.hasQr, false);
      assert.equal(linkedStatus.qr, undefined);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

test('logout and socket close drop a stale qr', async () => {
  await withBridge(async (bridge, sockets) => {
    const first = sockets[0];
    first.emit('connection.update', { qr: QR });
    first.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('restart', { statusCode: 515 }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.getStatus().hasQr, false);
    assert.equal(bridge.getStatus().status, 'reconnecting');

    first.emit('connection.update', { qr: QR });
    assert.equal(bridge.getStatus().hasQr, false);

    await bridge.logout();
    assert.equal(bridge.getStatus().hasQr, false);
    assert.throws(() => bridge.getQr(), (err) => err instanceof HttpError && err.status === 404);
    first.emit('connection.update', { qr: QR });
    assert.equal(bridge.getStatus().hasQr, false);

    const fresh = sockets[sockets.length - 1];
    assert.notEqual(fresh, first);
    fresh.emit('connection.update', { qr: QR_NEXT });
    assert.equal(bridge.getQr().qr, QR_NEXT);
    assert.equal(bridge.getStatus().hasQr, true);
  });
});

test('logged-out disconnect clears the qr without reconnecting', async () => {
  await withBridge(async (bridge, sockets) => {
    sockets[0].emit('connection.update', { qr: QR });
    sockets[0].emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Boom('logged out', { statusCode: 401 }) },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const status = bridge.getStatus();
    assert.equal(status.status, 'loggedOut');
    assert.equal(status.hasQr, false);
    assertQrHidden(status);
    assert.equal(sockets.length, 1);
  });
});

test('phone pairing still returns a code while a qr is available', async () => {
  await withBridge(async (bridge, sockets) => {
    const sock = sockets[0];
    sock.emit('connection.update', { qr: QR });
    const paired = await bridge.pair('15551234567');
    assert.deepEqual(paired, { pairingCode: 'ABCD1234', phone: '15551234567' });
    assert.equal(sock.pairedPhone, '15551234567');
    const status = bridge.getStatus();
    assert.equal(status.pairingCode, 'ABCD1234');
    assert.equal(status.hasQr, true);
    assert.equal(bridge.getQr().qr, QR);
    assertQrHidden(status);
  });
});
