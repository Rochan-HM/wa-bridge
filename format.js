'use strict';

const crypto = require('crypto');
const { Boom } = require('@hapi/boom');

/** WhatsApp stream codes mirrored by Baileys DisconnectReason. */
const DISCONNECT = {
  loggedOut: 401,
  restartRequired: 515,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function normalizePairPhone(input) {
  if (input == null) return '';
  return String(input).replace(/\D/g, '');
}

function assertPairPhone(digits) {
  if (!digits) throw new HttpError(400, 'phone is required');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new HttpError(400, 'phone must be 8-15 digits including country code');
  }
  return digits;
}

/**
 * Use a JID as given (including @lid, @g.us, @s.whatsapp.net).
 * Digits-only values become a user JID.
 */
function resolveJid(to) {
  if (typeof to === 'number' && Number.isSafeInteger(to)) to = String(to);
  if (typeof to !== 'string') throw new HttpError(400, 'to is required');
  const raw = to.trim();
  if (!raw) throw new HttpError(400, 'to is required');
  if (raw.includes('@')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new HttpError(400, 'to must be a phone number or JID');
  return `${digits}@s.whatsapp.net`;
}

function assertText(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new HttpError(400, 'text is required');
  }
  if (text.length > 65536) throw new HttpError(400, 'text is too long');
  return text;
}

function checkBearer(header, token) {
  if (!token || typeof header !== 'string') return false;
  const match = header.trim().match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(String(token));
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function statusCodeFromDisconnect(error) {
  if (!error) return undefined;
  if (typeof error.output?.statusCode === 'number') return error.output.statusCode;
  if (error.isBoom) return error.output?.statusCode;
  try {
    const boom = new Boom(error);
    return boom.output?.statusCode;
  } catch {
    return undefined;
  }
}

function classifyDisconnect(statusCode) {
  if (statusCode === DISCONNECT.loggedOut) return { action: 'loggedOut' };
  if (statusCode === DISCONNECT.restartRequired) return { action: 'reconnect', fast: true };
  if (statusCode == null) return { action: 'reconnect', dead: true };
  return { action: 'reconnect', dead: false };
}

function timestampToIso(ts) {
  let n;
  if (ts == null) n = Date.now();
  else if (typeof ts === 'object' && typeof ts.toNumber === 'function') n = ts.toNumber();
  else n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) n = Date.now();
  else if (n < 1e12) n = n * 1000;
  return new Date(n).toISOString();
}

function extractText(msg) {
  const m = msg?.message || {};
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text };
  if (m.imageMessage) return { text: m.imageMessage.caption || null, mediaType: 'image' };
  if (m.videoMessage) return { text: m.videoMessage.caption || null, mediaType: 'video' };
  if (m.audioMessage) return { text: null, mediaType: 'audio' };
  if (m.documentMessage) {
    return { text: m.documentMessage.caption || m.documentMessage.fileName || null, mediaType: 'document' };
  }
  if (m.stickerMessage) return { text: null, mediaType: 'sticker' };
  if (m.contactMessage) return { text: m.contactMessage.displayName || null, mediaType: 'contact' };
  if (m.contactsArrayMessage) return { text: null, mediaType: 'contact' };
  if (m.locationMessage || m.liveLocationMessage) return { text: null, mediaType: 'location' };
  if (m.reactionMessage) return { text: m.reactionMessage.text || null, mediaType: 'reaction' };
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const poll = m.pollCreationMessage || m.pollCreationMessageV3;
    return { text: poll.name || null, mediaType: 'poll' };
  }
  const alt =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message ||
    m.documentWithCaptionMessage?.message ||
    m.editedMessage?.message;
  if (alt) return extractText({ message: alt });
  if (m.protocolMessage) return { text: null, mediaType: 'protocol' };
  const keys = Object.keys(m);
  return { text: null, mediaType: keys[0] || 'unknown' };
}

/** Return the webhook body, or null when the message should be ignored. */
function buildInbound(msg) {
  if (!msg?.message || msg.key?.fromMe) return null;
  const extracted = extractText(msg);
  if (extracted.mediaType === 'protocol') return null;
  const chatId = msg.key?.remoteJid || '';
  if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@broadcast')) return null;
  const isGroup = chatId.endsWith('@g.us');
  const from = isGroup ? (msg.key.participant || msg.participant || chatId) : chatId;
  const entry = {
    ts: timestampToIso(msg.messageTimestamp),
    from,
    pushName: msg.pushName || null,
    chatId,
    isGroup,
    text: extracted.text ?? null,
    msgId: msg.key?.id || null,
  };
  if (extracted.mediaType) entry.mediaType = extracted.mediaType;
  return { source: 'whatsapp', entry };
}

function statusBody({ status, phone, pairingCode, updatedAt, hasQr }) {
  const body = {
    status,
    phone: phone || null,
    updatedAt,
    hasQr: status !== 'connected' && !!hasQr,
  };
  if (status === 'waiting-for-pairing-code' && pairingCode) body.pairingCode = pairingCode;
  return body;
}

function phoneFromUserId(id) {
  if (!id) return null;
  const user = String(id).split('@')[0].split(':')[0];
  return user || null;
}

function safeWebhookUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.toString();
}

module.exports = {
  DISCONNECT,
  HttpError,
  normalizePairPhone,
  assertPairPhone,
  resolveJid,
  assertText,
  checkBearer,
  statusCodeFromDisconnect,
  classifyDisconnect,
  timestampToIso,
  extractText,
  buildInbound,
  statusBody,
  phoneFromUserId,
  safeWebhookUrl,
};
