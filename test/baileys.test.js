'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DISCONNECT } = require('../format');

test('installed Baileys exports the pairing socket API', async () => {
  const baileys = await import('@whiskeysockets/baileys');
  assert.equal(typeof baileys.default, 'function');
  assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  assert.equal(typeof baileys.makeCacheableSignalKeyStore, 'function');
  assert.equal(typeof baileys.fetchLatestBaileysVersion, 'function');
  assert.equal(typeof baileys.isJidBroadcast, 'function');
  assert.equal(baileys.DisconnectReason.loggedOut, DISCONNECT.loggedOut);
  assert.equal(baileys.DisconnectReason.restartRequired, DISCONNECT.restartRequired);
});
