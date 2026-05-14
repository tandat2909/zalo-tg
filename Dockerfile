# syntax=docker/dockerfile:1.7

# ── Stage 1: install all deps (dev + prod) ───────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: build TypeScript → dist/ ────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 3: prod-only deps (smaller layer for runtime) ──────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 4: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# ffmpeg cần cho convertToM4a / extractVideoThumbnail / convertWebmToGif
# tini = init thật để xử lý SIGTERM đúng, tránh Node thành PID 1 bị treo khi shutdown
RUN apk add --no-cache ffmpeg tini tzdata \
 && addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production \
    TZ=Asia/Ho_Chi_Minh \
    DATA_DIR=/data

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist          ./dist
COPY package.json ./

# Thư mục dữ liệu bền vững (topics.json, msg-map.json.gz, reminders.json, ...)
RUN mkdir -p /data && chown -R app:app /data /app
USER app

VOLUME ["/data"]

# Bot polling Telegram + Zalo, không expose port nào ra ngoài

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
