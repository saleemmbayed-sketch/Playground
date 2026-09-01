# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && cp -r node_modules /prod_modules && npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini curl && addgroup -S app && adduser -S app -G app
COPY --from=build /prod_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY data/fixtures ./data/fixtures
RUN mkdir -p /app/data && chown -R app:app /app/data
USER app
VOLUME ["/app/data"]
EXPOSE 3000
# Liveness only: /healthz stays 200 while the process serves traffic. Business health
# (stale ingest, failed sends) is /healthz?strict=1 — point your uptime monitor there,
# not Docker, or a fresh box with no data yet would restart-loop.
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:3000/healthz > /dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
