'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  HttpError,
  normalizePairPhone,
  assertPairPhone,
  resolveJid,
  assertText,
  statusCodeFromDisconnect,
  classifyDisconnect,
  statusBody,
  phoneFromUserId,
  safeWebhookUrl,
} = require('./format');
const { handleUpsert } = require('./inbound');

const PAIRING_CODE_TTL_MS = 120_000;
const PAIRING_READY_DELAY_MS = 1500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function clearDirContents(dir) {
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  await Promise.all(entries.map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })));
}

function createBridge({ env = process.env, logger } = {}) {
  const authDir = env.AUTH_DIR || '/data/baileys-auth';
  const dataDir = path.dirname(authDir);
  const inboxEnv = env.INBOX_PATH;
  const inboxDisabled = inboxEnv === 'off' || inboxEnv === '0' || inboxEnv === 'false';
  const log = logger.child({ component: 'wa' });
  const level = env.WA_LOG_LEVEL || 'info';
  const baileysLevel = level === 'debug' || level === 'trace' || level === 'silent' ? level : 'warn';
  const baileysLogger = logger.child({ component: 'baileys' });
  baileysLogger.level = baileysLevel;

  const bridge = {
    authDir,
    inboxPath: inboxDisabled ? null : (inboxEnv || path.join(dataDir, 'inbox.jsonl')),
    outboxPath: env.OUTBOX_PATH || path.join(dataDir, 'outbox.jsonl'),
    webhookUrl: safeWebhookUrl(env.WEBHOOK_URL || ''),
    webhookAuth: env.WEBHOOK_AUTH || '',
    envPhone: normalizePairPhone(env.PAIR_PHONE || ''),
    phone: null,
    userPhone: null,
    status: 'starting',
    updatedAt: new Date().toISOString(),
    codeState: null,
    registered: false,
    sock: null,
    generation: 0,
    qrAt: 0,
    issue: null,
    queue: [],
    draining: false,
    stopped: false,
    backoff: 2000,
    chain: Promise.resolve(),
    timer: null,
    drainTimer: null,
    credSave: Promise.resolve(),
    baileys: null,
    log,
    baileysLogger,
  };

  if (env.WEBHOOK_URL && !bridge.webhookUrl) {
    log.warn('WEBHOOK_URL is not a valid http(s) URL; inbound webhook disabled');
  }
  if (bridge.envPhone && /^\d{8,15}$/.test(bridge.envPhone)) bridge.phone = bridge.envPhone;
  else if (bridge.envPhone) log.warn('PAIR_PHONE is invalid; ignoring');

  function setStatus(status) {
    const changed = status !== bridge.status;
    bridge.status = status;
    bridge.updatedAt = new Date().toISOString();
    if (changed) log.info({ status, phone: displayPhone() }, 'status');
  }

  function displayPhone() {
    return bridge.userPhone || bridge.phone || null;
  }

  function lock(fn) {
    const run = bridge.chain.then(fn, fn);
    bridge.chain = run.then(() => {}, () => {});
    return run;
  }

  function clearTimer() {
    if (bridge.timer) {
      clearTimeout(bridge.timer);
      bridge.timer = null;
    }
  }

  function freshCode(phone) {
    return !!(
      bridge.codeState &&
      bridge.codeState.phone === phone &&
      bridge.status === 'waiting-for-pairing-code' &&
      Date.now() - bridge.codeState.at < PAIRING_CODE_TTL_MS
    );
  }

  async function loadBaileys() {
    if (!bridge.baileys) bridge.baileys = await import('@whiskeysockets/baileys');
    return bridge.baileys;
  }

  async function loadQueue() {
    let raw = '';
    try {
      raw = await fs.readFile(bridge.outboxPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn({ err: String(err) }, 'failed to read outbox');
      return;
    }
    const jobs = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const job = JSON.parse(line);
        if (job && job.jid && typeof job.text === 'string') jobs.push(job);
      } catch {
        log.warn('skipping corrupt outbox line');
      }
    }
    bridge.queue = jobs;
  }

  async function persistQueue() {
    await fs.mkdir(path.dirname(bridge.outboxPath), { recursive: true });
    const body = bridge.queue.map((job) => JSON.stringify(job)).join('\n') + (bridge.queue.length ? '\n' : '');
    const tmp = `${bridge.outboxPath}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, bridge.outboxPath);
  }

  async function drain() {
    if (bridge.draining) return;
    bridge.draining = true;
    try {
      while (bridge.queue.length && bridge.status === 'connected' && bridge.sock) {
        const job = bridge.queue[0];
        try {
          await bridge.sock.sendMessage(job.jid, { text: job.text });
          bridge.queue.shift();
          await persistQueue();
          log.info({ jid: job.jid, id: job.id }, 'queued message sent');
        } catch (err) {
          job.attempts = (job.attempts || 0) + 1;
          log.error({ err: String(err), id: job.id, attempts: job.attempts }, 'queued send failed');
          if (job.attempts >= 5) {
            bridge.queue.shift();
            await persistQueue();
            continue;
          }
          break;
        }
      }
    } finally {
      bridge.draining = false;
    }
  }

  function scheduleReconnect(gen, statusCode) {
    if (bridge.stopped || gen !== bridge.generation) return;
    const decision = classifyDisconnect(statusCode);
    if (decision.action === 'loggedOut') {
      bridge.registered = false;
      bridge.codeState = null;
      bridge.userPhone = null;
      setStatus('loggedOut');
      log.warn({ statusCode }, 'logged out; HTTP stays up — POST /logout to clear auth and pair again');
      return;
    }
    const delayMs = decision.fast ? 500 : bridge.backoff;
    if (decision.fast) bridge.backoff = 2000;
    else bridge.backoff = Math.min(bridge.backoff * 2, 30000);
    setStatus(decision.dead ? 'dead' : 'reconnecting');
    clearTimer();
    bridge.timer = setTimeout(() => {
      lock(async () => {
        if (bridge.stopped || gen !== bridge.generation) return;
        await openSocket();
      }).catch((err) => log.error({ err: String(err) }, 'reconnect failed'));
    }, delayMs);
  }

  async function destroySocket() {
    const sock = bridge.sock;
    bridge.sock = null;
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch { /* ignore */ }
    try { sock.end(undefined); } catch { /* ignore */ }
  }

  async function openSocket() {
    if (bridge.stopped) return;
    const gen = ++bridge.generation;
    clearTimer();
    try {
      await openSocketBody(gen);
    } catch (err) {
      if (bridge.stopped || gen !== bridge.generation) return;
      log.error({ err: String(err) }, 'socket start failed');
      scheduleReconnect(gen, undefined);
      throw err;
    }
  }

  async function openSocketBody(gen) {
    await destroySocket();
    bridge.qrAt = 0;
    bridge.codeState = null;
    bridge.issue = null;
    bridge.credSave = Promise.resolve();
    setStatus('starting');

    const baileys = await loadBaileys();
    if (gen !== bridge.generation || bridge.stopped) return;
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      isJidBroadcast,
      DisconnectReason,
    } = baileys;

    await fs.mkdir(bridge.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(bridge.authDir);
    if (gen !== bridge.generation || bridge.stopped) return;
    bridge.registered = !!state.creds.registered;

    let version;
    try {
      const fetched = await withTimeout(fetchLatestBaileysVersion(), 8000);
      version = fetched?.version;
      log.info({ version }, 'using WA web version');
    } catch (err) {
      log.warn({ err: String(err) }, 'fetchLatestBaileysVersion failed; using default');
    }
    if (gen !== bridge.generation || bridge.stopped) return;

    const options = {
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      getMessage: async () => undefined,
    };
    if (version) options.version = version;

    const sock = makeWASocket(options);
    if (gen !== bridge.generation || bridge.stopped) {
      try { sock.end(undefined); } catch { /* ignore */ }
      return;
    }
    bridge.sock = sock;

    sock.ev.on('creds.update', () => {
      if (gen !== bridge.generation) return;
      const pending = bridge.credSave.then(() => saveCreds());
      bridge.credSave = pending.catch((err) => {
        log.error({ err: String(err) }, 'failed to save creds');
      });
      bridge.registered = !!sock.authState?.creds?.registered;
    });

    sock.ev.on('connection.update', (update) => {
      onConnection(sock, gen, update, DisconnectReason).catch((err) => {
        log.error({ err: String(err) }, 'connection update failed');
      });
    });

    sock.ev.on('messages.upsert', (upsert) => {
      if (gen !== bridge.generation) return;
      handleUpsert(upsert, {
        inboxPath: bridge.inboxPath,
        webhookUrl: bridge.webhookUrl,
        webhookAuth: bridge.webhookAuth,
        log,
      }).catch((err) => log.error({ err: String(err) }, 'inbound handler failed'));
    });
  }

  async function onConnection(sock, gen, update, DisconnectReason) {
    if (gen !== bridge.generation) return;
    const { connection, lastDisconnect, qr } = update;

    // Baileys emits `qr` once the socket can accept a pairing IQ. Calling
    // requestPairingCode earlier fails with "Connection Closed".
    if (qr && !sock.authState?.creds?.registered) {
      bridge.qrAt = Date.now();
      setStatus('waiting-for-pairing-code');
      if (bridge.phone) {
        issuePairing(bridge.phone).catch((err) => {
          log.error({ err: err.message }, 'pairing request failed');
        });
      }
    }

    if (connection === 'open') {
      bridge.registered = true;
      bridge.backoff = 2000;
      bridge.codeState = null;
      const userPhone = phoneFromUserId(sock.user?.id);
      if (userPhone) bridge.userPhone = userPhone;
      if (userPhone && /^\d{8,15}$/.test(userPhone)) bridge.phone = userPhone;
      setStatus('connected');
      log.info({ phone: displayPhone(), id: sock.user?.id }, 'WhatsApp connected');
      drain().catch((err) => log.error({ err: String(err) }, 'drain failed'));
    }

    if (connection === 'close') {
      try { await bridge.credSave; } catch { /* logged above */ }
      if (gen !== bridge.generation) return;
      const statusCode = statusCodeFromDisconnect(lastDisconnect?.error);
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log.warn({ statusCode, loggedOut }, 'connection closed');
      if (bridge.sock === sock) bridge.sock = null;
      scheduleReconnect(gen, statusCode);
    }
  }

  function issuePairing(phone) {
    if (freshCode(phone)) {
      return Promise.resolve({ pairingCode: bridge.codeState.code, phone });
    }
    const gen = bridge.generation;
    const key = `${gen}:${phone}`;
    if (bridge.issue?.key === key) return bridge.issue.promise;
    const sock = bridge.sock;
    if (!sock) throw new HttpError(503, 'socket not ready');
    const promise = requestCode(sock, gen, phone);
    bridge.issue = { key, promise };
    promise.finally(() => {
      if (bridge.issue?.promise === promise) bridge.issue = null;
    });
    return promise;
  }

  async function requestCode(sock, gen, phone) {
    const elapsed = Date.now() - (bridge.qrAt || Date.now());
    if (elapsed < PAIRING_READY_DELAY_MS) await delay(PAIRING_READY_DELAY_MS - elapsed);
    if (gen !== bridge.generation || bridge.sock !== sock) {
      throw new HttpError(503, 'socket restarted during pairing');
    }
    if (sock.authState?.creds?.registered) throw new HttpError(409, 'already connected');
    let code;
    try {
      code = await sock.requestPairingCode(phone);
    } catch (err) {
      log.error({ err: String(err) }, 'requestPairingCode failed');
      throw new HttpError(502, 'failed to request pairing code');
    }
    if (gen !== bridge.generation) throw new HttpError(503, 'socket restarted during pairing');
    const pairingCode = String(code).trim();
    bridge.codeState = { phone, code: pairingCode, at: Date.now() };
    setStatus('waiting-for-pairing-code');
    log.info({ phone, pairingCode }, 'pairing code issued');
    return { pairingCode, phone };
  }

  function waitForQr(ms) {
    if (bridge.qrAt && bridge.sock && !bridge.sock.authState?.creds?.registered) return Promise.resolve();
    if (bridge.status === 'connected' || bridge.status === 'loggedOut' || bridge.status === 'dead') {
      return Promise.resolve();
    }
    if (bridge.status === 'waiting-for-pairing-code' && bridge.sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new HttpError(504, 'timed out waiting for pairing'));
      }, ms);
      const interval = setInterval(() => {
        if (
          bridge.qrAt ||
          bridge.status === 'connected' ||
          bridge.status === 'loggedOut' ||
          bridge.status === 'dead' ||
          bridge.status === 'waiting-for-pairing-code'
        ) {
          cleanup();
          resolve();
        }
      }, 100);
      function cleanup() {
        clearTimeout(timer);
        clearInterval(interval);
      }
    });
  }

  async function ensureSocket() {
    if (bridge.stopped || bridge.sock) return;
    if (bridge.status === 'reconnecting' || bridge.status === 'loggedOut') return;
    await openSocket();
  }

  return {
    start() {
      return lock(async () => {
        await loadQueue();
        if (!bridge.drainTimer) {
          bridge.drainTimer = setInterval(() => {
            drain().catch((err) => log.error({ err: String(err) }, 'drain failed'));
          }, 2000);
          bridge.drainTimer.unref?.();
        }
        await ensureSocket();
      });
    },

    async halt() {
      bridge.stopped = true;
      clearTimer();
      if (bridge.drainTimer) {
        clearInterval(bridge.drainTimer);
        bridge.drainTimer = null;
      }
      bridge.generation += 1;
      const sock = bridge.sock;
      bridge.sock = null;
      if (sock) {
        try { sock.ev.removeAllListeners(); } catch { /* ignore */ }
        try { sock.end(undefined); } catch { /* ignore */ }
      }
      try { await bridge.credSave; } catch { /* already logged */ }
    },

    getStatus() {
      return statusBody({
        status: bridge.status,
        phone: displayPhone(),
        pairingCode: bridge.codeState?.code,
        updatedAt: bridge.updatedAt,
      });
    },

    async pair(rawPhone) {
      const phone = assertPairPhone(normalizePairPhone(rawPhone ?? bridge.phone ?? ''));
      const phoneChanged = !!(bridge.codeState && bridge.codeState.phone !== phone);
      bridge.phone = phone;
      if (!phoneChanged && freshCode(phone)) {
        return { pairingCode: bridge.codeState.code, phone };
      }

      await lock(async () => {
        if (bridge.stopped) throw new HttpError(503, 'shutting down');
        if (bridge.status === 'loggedOut') {
          throw new HttpError(409, 'logged out; POST /logout to clear auth and pair again');
        }
        if (bridge.sock?.authState?.creds?.registered && bridge.status === 'connected') {
          throw new HttpError(409, 'already connected');
        }
        if (phoneChanged || bridge.status === 'dead') await openSocket();
        else await ensureSocket();
      });

      if (bridge.sock?.authState?.creds?.registered || (bridge.status === 'connected' && bridge.registered)) {
        throw new HttpError(409, 'already connected');
      }
      if (bridge.status === 'loggedOut') {
        throw new HttpError(409, 'logged out; POST /logout to clear auth and pair again');
      }

      await waitForQr(20000);
      if (bridge.sock?.authState?.creds?.registered) throw new HttpError(409, 'already connected');
      if (freshCode(phone)) return { pairingCode: bridge.codeState.code, phone };
      return issuePairing(phone);
    },

    async send({ to, text }) {
      const jid = resolveJid(to);
      const body = assertText(text);
      if (bridge.status === 'connected' && bridge.sock) {
        try {
          const res = await bridge.sock.sendMessage(jid, { text: body });
          return { ok: true, queued: false, jid, msgId: res?.key?.id || null };
        } catch (err) {
          log.error({ err: String(err), jid }, 'send failed');
          throw new HttpError(502, 'send failed');
        }
      }
      const job = {
        id: randomUUID(),
        jid,
        text: body,
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };
      bridge.queue.push(job);
      try {
        await persistQueue();
      } catch (err) {
        bridge.queue = bridge.queue.filter((item) => item.id !== job.id);
        log.error({ err: String(err), id: job.id }, 'failed to persist outbox');
        throw new HttpError(503, 'failed to queue message');
      }
      log.info({ jid, id: job.id }, 'send queued');
      return { ok: true, queued: true, jid, id: job.id };
    },

    logout() {
      return lock(async () => {
        if (bridge.stopped) throw new HttpError(503, 'shutting down');
        clearTimer();
        const sock = bridge.sock;
        bridge.generation += 1;
        bridge.sock = null;
        bridge.codeState = null;
        bridge.issue = null;
        bridge.registered = false;
        bridge.userPhone = null;
        bridge.qrAt = 0;
        if (sock) {
          try { sock.ev.removeAllListeners(); } catch { /* ignore */ }
          try { await bridge.credSave; } catch { /* already logged */ }
          try { await withTimeout(sock.logout(), 8000); } catch (err) {
            log.warn({ err: String(err) }, 'logout iq failed');
          }
          try { sock.end(undefined); } catch { /* ignore */ }
        }
        await clearDirContents(bridge.authDir);
        log.info({ authDir: bridge.authDir }, 'auth cleared');
        try {
          await openSocket();
        } catch (err) {
          log.error({ err: String(err) }, 'restart after logout failed');
        }
        return { ok: true };
      });
    },
  };
}

module.exports = {
  createBridge,
  clearDirContents,
};
