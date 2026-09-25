FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json .prettierrc ./
COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ARG GALLERY_DL_VERSION=1.32.10
ARG YT_DLP_VERSION=2026.8.19

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && python3 -m venv /opt/media-tools \
    && /opt/media-tools/bin/pip install --no-cache-dir \
        "gallery-dl==${GALLERY_DL_VERSION}" \
        "yt-dlp[default,curl-cffi]==${YT_DLP_VERSION}" \
    && ln -s /opt/media-tools/bin/gallery-dl /usr/local/bin/gallery-dl \
    && ln -s /opt/media-tools/bin/yt-dlp /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    GALLERY_DL_PATH=/usr/local/bin/gallery-dl \
    YTDLP_PATH=/usr/local/bin/yt-dlp

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data/storage /data/temp \
    && chown -R node:node /data
USER node

ENV WORKER_STORAGE_DIR=/data/storage \
    WORKER_TEMP_DIR=/data/temp

ENTRYPOINT ["node", "dist/queue-worker.js"]
