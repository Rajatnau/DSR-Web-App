# node:sqlite is built in from Node 22.5 — no native build toolchain needed.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so this layer caches across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# dsr.db, DSR.xlsx and backups/ live here. Mount a volume so they survive
# container restarts and redeploys.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
