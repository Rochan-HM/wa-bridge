'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Boom } = require('@hapi/boom');
const {
  HttpError,
  normalizePairPhone,
  assertPairPhone,
  resolveJid,
  assertText,
  checkBearer,
  statusCodeFromDisconnect,
  classifyDisconnect,
  buildInbound,
  statusBody,
  phoneFromUserId,
  safeWebhookUrl,
  DISCONNECT,
} = require('../format');

test('normalize and validate pairing phone', () => {
  assert.equal(normalizePairPhone('+1 (555) 123-4567'), '15551234567');
  assert.equal(assertPairPhone('15551234567'), '15551234567');
  assert.throws(() => assertPairPhone('123'), HttpError);
  assert.throws(() => assertPairPhone(''), HttpError);
});

test('resolveJid keeps explicit JIDs including @lid', () => {
  assert.equal(resolveJid('abc@lid'), 'abc@lid');
  assert.equal(resolveJid('  15551234567@s.whatsapp.net '), '15551234567@s.whatsapp.net');
  assert.equal(resolveJid('1203630@g.us'), '1203630@g.us');
  assert.equal(resolveJid('+1 (555) 123-4567'), '15551234567@s.whatsapp.net');
  assert.equal(resolveJid(15551234567), '15551234567@s.whatsapp.net');
  assert.throws(() => resolveJid(''), HttpError);
  assert.throws(() => resolveJid('+++'), HttpError);
});

test('assertText rejects empty and oversized bodies', () => {
  assert.equal(assertText('hello'), 'hello');
  assert.throws(() => assertText(''), HttpError);
  assert.throws(() => assertText(null), HttpError);
  assert.throws(() => assertText('x'.repeat(65537)), HttpError);
});

test('checkBearer compares the token in constant time', () => {
  assert.equal(checkBearer('Bearer secret', 'secret'), true);
  assert.equal(checkBearer('bearer secret', 'secret'), true);
  assert.equal(checkBearer('Bearer wrong', 'secret'), false);
  assert.equal(checkBearer('Bearer secret-extra', 'secret'), false);
  assert.equal(checkBearer('Basic secret', 'secret'), false);
  assert.equal(checkBearer(undefined, 'secret'), false);
  assert.equal(checkBearer('Bearer secret', ''), false);
  assert.equal(checkBearer('Bearer secret', undefined), false);
});

test('disconnect classification matches Baileys codes', () => {
  assert.equal(DISCONNECT.loggedOut, 401);
  assert.equal(DISCONNECT.restartRequired, 515);
  assert.deepEqual(classifyDisconnect(401), { action: 'loggedOut' });
  assert.deepEqual(classifyDisconnect(515), { action: 'reconnect', fast: true });
  assert.equal(classifyDisconnect(428).action, 'reconnect');
  assert.equal(classifyDisconnect(undefined).dead, true);
  const boom = new Boom('Connection Failure', { statusCode: 401 });
  assert.equal(statusCodeFromDisconnect(boom), 401);
  assert.equal(statusCodeFromDisconnect({ output: { statusCode: 515 } }), 515);
  assert.equal(statusCodeFromDisconnect(undefined), undefined);
});

test('buildInbound shapes notify messages and skips own and protocol', () => {
  const text = buildInbound({
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm1' },
    pushName: 'Ada',
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hello' },
  });
  assert.deepEqual(text, {
    source: 'whatsapp',
    entry: {
      ts: new Date(1_700_000_000 * 1000).toISOString(),
      from: '15551234567@s.whatsapp.net',
      pushName: 'Ada',
      chatId: '15551234567@s.whatsapp.net',
      isGroup: false,
      text: 'hello',
      msgId: 'm1',
    },
  });

  const lid = buildInbound({
    key: { remoteJid: '12345@lid', fromMe: false, id: 'm2' },
    messageTimestamp: 1_700_000_000,
    message: { extendedTextMessage: { text: 'lid hi' } },
  });
  assert.equal(lid.entry.chatId, '12345@lid');
  assert.equal(lid.entry.text, 'lid hi');

  const group = buildInbound({
    key: { remoteJid: '120@g.us', participant: '15551234567@s.whatsapp.net', fromMe: false, id: 'm3' },
    messageTimestamp: 1_700_000_000,
    message: { imageMessage: { caption: 'pic' } },
  });
  assert.equal(group.entry.isGroup, true);
  assert.equal(group.entry.from, '15551234567@s.whatsapp.net');
  assert.equal(group.entry.chatId, '120@g.us');
  assert.equal(group.entry.mediaType, 'image');
  assert.equal(group.entry.text, 'pic');

  const wrapped = buildInbound({
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm4' },
    messageTimestamp: 1_700_000_000,
    message: { ephemeralMessage: { message: { conversation: 'hidden' } } },
  });
  assert.equal(wrapped.entry.text, 'hidden');
  assert.equal(wrapped.entry.mediaType, undefined);

  assert.equal(buildInbound({
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: true, id: 'm5' },
    message: { conversation: 'me' },
  }), null);
  assert.equal(buildInbound({
    key: { remoteJid: '15551234567@s.whatsapp.net', fromMe: false, id: 'm6' },
    message: { protocolMessage: { type: 0 } },
  }), null);
  assert.equal(buildInbound({
    key: { remoteJid: 'status@broadcast', fromMe: false, id: 'm7' },
    message: { conversation: 'story' },
  }), null);
});

test('status body includes pairingCode only while waiting and never the qr payload', () => {
  assert.deepEqual(statusBody({
    status: 'connected',
    phone: '15551234567',
    pairingCode: 'ABCD1234',
    updatedAt: 't',
    hasQr: true,
  }), { status: 'connected', phone: '15551234567', updatedAt: 't', hasQr: false });

  assert.deepEqual(statusBody({
    status: 'waiting-for-pairing-code',
    phone: '15551234567',
    pairingCode: 'ABCD1234',
    updatedAt: 't',
    hasQr: true,
  }), {
    status: 'waiting-for-pairing-code',
    phone: '15551234567',
    pairingCode: 'ABCD1234',
    updatedAt: 't',
    hasQr: true,
  });

  const waiting = statusBody({
    status: 'starting',
    phone: null,
    updatedAt: 't',
  });
  assert.equal(waiting.hasQr, false);
  assert.equal(Object.hasOwn(waiting, 'qr'), false);
  assert.equal(Object.hasOwn(waiting, 'pairingCode'), false);
});

test('phoneFromUserId strips the device suffix', () => {
  assert.equal(phoneFromUserId('15551234567:14@s.whatsapp.net'), '15551234567');
  assert.equal(phoneFromUserId(''), null);
});

test('safeWebhookUrl allows only http(s)', () => {
  assert.equal(safeWebhookUrl('https://example.com/hook'), 'https://example.com/hook');
  assert.equal(safeWebhookUrl('not a url'), null);
  assert.equal(safeWebhookUrl('ftp://example.com/hook'), null);
  assert.equal(safeWebhookUrl(''), null);
});
