FROM node:22-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build

WORKDIR /app
RUN apk add --no-cache python3 \
    && ln -s /usr/bin/python3 /usr/local/bin/python
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json .prettierrc ./
COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod

FROM node:22-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime

ARG GALLERY_DL_VERSION=1.32.17
ARG YT_DLP_VERSION=2026.8.19

RUN apk add --no-cache ca-certificates ffmpeg python3 py3-pip util-linux-misc \
    && python3 -m venv /opt/media-tools \
    && /opt/media-tools/bin/pip install --no-cache-dir \
        "gallery-dl==${GALLERY_DL_VERSION}" \
        "yt-dlp[default,curl-cffi]==${YT_DLP_VERSION}" \
    && ln -s /opt/media-tools/bin/gallery-dl /usr/local/bin/gallery-dl \
    && ln -s /opt/media-tools/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    GALLERY_DL_PATH=/usr/local/bin/gallery-dl \
    YTDLP_PATH=/usr/local/bin/yt-dlp

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs

RUN apk add --no-cache 'zlib>=1.4-r0' \
    && mkdir -p /data/storage /data/temp \
    && chown -R node:node /data
USER node

ENV WORKER_STORAGE_DIR=/data/storage \
    WORKER_TEMP_DIR=/data/temp

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["node", "dist/queue-worker.js"]
