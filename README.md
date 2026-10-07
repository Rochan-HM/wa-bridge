# wa-bridge

Always-on WhatsApp companion for a number that is already registered. One Node process links as a device with a phone pairing code, keeps the Baileys session on a volume, and exposes a small HTTP API. Inbound messages are posted to your webhook. Outbound sends are authenticated.

This uses [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. It does not register a new account. WhatsApp can limit or ban numbers that use unofficial clients.

## Coolify

1. New resource → Application. Build pack: **Dockerfile**. Port: **3000**.
2. Leave the public domain empty when nothing else needs to call in. The bridge only has to reach the internet for WhatsApp and, if you set one, `WEBHOOK_URL`.
3. Persistent storage: mount a volume at **`/data`**. The session lives in `/data/baileys-auth` (`AUTH_DIR`). Inbox and the send queue are `/data/inbox.jsonl` and `/data/outbox.jsonl`, so they stay on the same volume. Deleting the volume unlinks the companion; you will need a new pairing code.
4. Health check: `GET /health`. That endpoint is process liveness. It stays `200` when WhatsApp is logged out or reconnecting, so Coolify does not restart the container and drop an in-progress pairing code. Use `GET /status` for the WhatsApp state.
5. Set the environment variables below and deploy. The container runs a single process: `node server.js`.

Redeploys send `SIGTERM`. The process closes the socket and **does not** unlink the device. The session on `/data` is reused.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `API_TOKEN` | unset | Bearer token required for `POST /send`. If unset, every send is `401`. |
| `WEBHOOK_URL` | unset | Where inbound messages are POSTed |
| `WEBHOOK_AUTH` | unset | Full `Authorization` header value, for example `Bearer whsec_…` |
| `AUTH_DIR` | `/data/baileys-auth` | Multi-file Baileys auth state |
| `PAIR_PHONE` | unset | Default pairing number: digits, country code, no `+` |
| `WA_LOG_LEVEL` | `info` | Pino level. Baileys itself stays at `warn` unless this is `debug`, `trace`, or `silent` |
| `INBOX_PATH` | `/data/inbox.jsonl` | Append-only inbound log. Set to `off` to disable |
| `OUTBOX_PATH` | `/data/outbox.jsonl` | Queue for sends accepted while the socket is down |

Generate a token with `openssl rand -hex 24`. Do not commit tokens, auth files, or `.env`.

## HTTP API

`GET /health`

```json
{ "ok": true }
```

`GET /status`

```json
{ "status": "waiting-for-pairing-code", "phone": "15551234567", "pairingCode": "ABCD1234", "updatedAt": "2026-01-01T00:00:00.000Z" }
```

`status` is one of `starting`, `waiting-for-pairing-code`, `connected`, `reconnecting`, `loggedOut`, `dead`. `pairingCode` is present only while a code is waiting to be entered. `phone` is the `PAIR_PHONE` / pair request, or the linked user id once connected.

`POST /pair`

```bash
curl -s -X POST http://127.0.0.1:3000/pair \
  -H 'content-type: application/json' \
  -d '{"phone":"15551234567"}'
```

Body is optional. With no `phone`, the bridge uses `PAIR_PHONE`. Response:

```json
{ "pairingCode": "ABCD1234", "phone": "15551234567" }
```

On the phone: **WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead**, then enter the code. If `PAIR_PHONE` is set, the process also requests a code on its own once the socket is ready; `GET /status` and the logs show it. A repeated `POST /pair` for the same number returns the current code for about two minutes instead of invalidating it.

`POST /send`

```bash
curl -s -X POST http://127.0.0.1:3000/send \
  -H "authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"15551234567","text":"hello"}'
```

`to` may be digits (a `@s.whatsapp.net` JID is added) or a JID passed through as given, including `@lid` and `@g.us`. Missing or wrong bearer token is `401`. A live socket returns `200` with `{ ok, queued: false, jid, msgId }`. If WhatsApp is not connected, the message is written to the outbox and the response is `202` with `{ ok, queued: true, jid, id }`. The queue is drained after reconnect. Failed queued sends are retried and dropped after five attempts.

`POST /logout`

Deletes the contents of `AUTH_DIR` (the directory itself stays, so a mounted volume is safe), unlinks the companion when the socket is up, and opens a new socket for pairing. The HTTP server stays up. `PAIR_PHONE` is still the default number.

```bash
curl -s -X POST http://127.0.0.1:3000/logout
```

`/pair` and `/logout` are not authenticated. Do not publish this port to the internet. `POST /send` is the only route that checks `API_TOKEN`.

After WhatsApp logs the device out, status becomes `loggedOut` and the process does **not** exit or reconnect. Call `POST /logout` to wipe the auth files and pair again.

## Inbound webhook

For each `messages.upsert` of type `notify`, messages sent by this device are ignored. Others are appended to the inbox log and, when `WEBHOOK_URL` is set, POSTed:

```json
{
  "source": "whatsapp",
  "entry": {
    "ts": "2026-01-01T00:00:00.000Z",
    "from": "15551234567@s.whatsapp.net",
    "pushName": "Ada",
    "chatId": "15551234567@s.whatsapp.net",
    "isGroup": false,
    "text": "hello",
    "msgId": "ABC"
  }
}
```

`mediaType` (`image`, `video`, `audio`, `document`, `sticker`, `contact`, `location`, `reaction`, `poll`, …) is included when the message is not plain text. `text` is the body or caption, or `null`. Group `from` is the participant; `chatId` is the chat JID. If `WEBHOOK_AUTH` is set, it is sent as the `Authorization` header unchanged.

## Local run

Node 20 or newer.

```bash
npm ci
mkdir -p data/baileys-auth
API_TOKEN=dev \
PAIR_PHONE=15551234567 \
AUTH_DIR=./data/baileys-auth \
PORT=3000 \
npm start
```

```bash
npm test
```

## Docker

```bash
docker build -t wa-bridge .
docker run --rm -p 3000:3000 \
  -e API_TOKEN=dev \
  -e PAIR_PHONE=15551234567 \
  -e WEBHOOK_URL=https://example.com/hook \
  -e WEBHOOK_AUTH='Bearer whsec_example' \
  -v wa-data:/data \
  wa-bridge
```

The image is `node:20-bookworm-slim`, installs production dependencies with `npm ci --omit=dev`, and starts `node server.js`.
