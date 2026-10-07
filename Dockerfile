FROM node:20-bookworm-slim

# Coolify's default health check runs curl (then wget). The slim image has neither.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    AUTH_DIR=/data/baileys-auth

RUN mkdir -p /data/baileys-auth

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# Liveness only. /health stays 200 while the process is up; /status is WhatsApp state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
