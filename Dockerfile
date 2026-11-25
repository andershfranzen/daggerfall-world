# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/daggerfallworld.db \
    ACCOUNTS_DB_PATH=/data/accounts.db \
    ARENA2_DIR=/gamedata/arena2 \
    TRUST_PROXY=1 \
    REQUIRE_HTTPS=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY client ./client
# Writable state lives only in /data (a volume). Game data is mounted read-only at /gamedata.
RUN mkdir -p /data /gamedata && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/me').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "server/main.js"]
