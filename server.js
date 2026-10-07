'use strict';

const http = require('http');
const pino = require('pino');
const QRCode = require('qrcode');
const { HttpError, checkBearer } = require('./format');
const { createBridge } = require('./bridge');

const QR_PNG_OPTIONS = {
  type: 'png',
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 512,
};

function renderQrPng(text) {
  return QRCode.toBuffer(text, QR_PNG_OPTIONS);
}

const MAX_BODY = 1_000_000;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (size === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null) return resolve({});
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'JSON object expected'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', (err) => fail(err));
  });
}

function createServer(bridge, env = process.env, logger = pino({ level: 'silent' })) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/status') {
        return sendJson(res, 200, bridge.getStatus());
      }
      if (req.method === 'GET' && (path === '/qr' || path === '/qr.json')) {
        const info = bridge.getQr();
        if (path === '/qr.json') return sendJson(res, 200, info);
        const png = await renderQrPng(info.qr);
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': png.length,
          'cache-control': 'no-store',
        });
        return res.end(png);
      }
      if (req.method === 'POST' && path === '/pair') {
        const body = await readJson(req);
        const result = await bridge.pair(body.phone);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && path === '/logout') {
        const result = await bridge.logout();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && path === '/send') {
        if (!checkBearer(req.headers.authorization, env.API_TOKEN)) {
          res.setHeader('www-authenticate', 'Bearer');
          return sendJson(res, 401, { error: 'unauthorized' });
        }
        const body = await readJson(req);
        const result = await bridge.send({ to: body.to, text: body.text });
        return sendJson(res, result.queued ? 202 : 200, result);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) logger.error({ err: String(err), stack: err?.stack }, 'request failed');
      if (res.headersSent || res.writableEnded) return;
      const message = err instanceof HttpError ? err.message : 'internal error';
      sendJson(res, status, { error: message });
    }
  });
}

function main() {
  const logger = pino({ level: process.env.WA_LOG_LEVEL || 'info' });
  const bridge = createBridge({ logger });
  const server = createServer(bridge, process.env, logger);
  const port = Number(process.env.PORT || 3000);
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    bridge.halt()
      .catch((err) => logger.error({ err: String(err) }, 'halt failed'))
      .finally(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 8000).unref();
      });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err: String(err) }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err: String(err), stack: err?.stack }, 'uncaughtException');
    shutdown('uncaughtException');
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'listening');
    bridge.start().catch((err) => logger.error({ err: String(err) }, 'bridge start failed'));
  });
}

if (require.main === module) main();

module.exports = { createServer, main, renderQrPng };
