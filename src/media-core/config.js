import dotenv from "dotenv";

dotenv.config({ quiet: true });

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function parseSize(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    if (!value) return fallback;

    const normalized = String(value).trim().toLowerCase();
    const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/);
    if (!match) return fallback;

    const amount = Number.parseFloat(match[1]);
    const unit = match[2] ?? "b";
    const multiplier = {
        b: 1,
        kb: 1024,
        kib: 1024,
        mb: MB,
        mib: MB,
        gb: 1024 * MB,
        gib: 1024 * MB,
    }[unit];

    return Math.min(Math.floor(amount * multiplier), max);
}

function parseList(value) {
    if (!value || String(value).trim().toLowerCase() === "none") return [];
    return String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

const ytdlpImpersonate = String(process.env.YTDLP_IMPERSONATE || "").trim();

export const config = {
    maxDownloadBytes: parseSize(process.env.MAX_DOWNLOAD_SIZE, 5 * GB, 100 * GB),
    minFreeDiskBytes: parseSize(process.env.MIN_FREE_DISK_SPACE, 2 * GB),
    httpResponseTimeoutMs: parseInteger(process.env.HTTP_RESPONSE_TIMEOUT_MS, 45_000, 5_000, 5 * 60_000),
    httpIdleTimeoutMs: parseInteger(process.env.HTTP_IDLE_TIMEOUT_MS, 60_000, 5_000, 5 * 60_000),
    pageMetadataTimeoutMs: parseInteger(process.env.PAGE_METADATA_TIMEOUT_MS, 12_000, 5_000, 60_000),
    ytdlpTimeoutMs: parseInteger(process.env.YTDLP_TIMEOUT_MS, 20 * 60_000, 30_000, 60 * 60_000),
    ffmpegTimeoutMs: parseInteger(process.env.FFMPEG_TIMEOUT_MS, 20 * 60_000, 30_000, 60 * 60_000),
    jobTimeoutMs: parseInteger(process.env.JOB_TIMEOUT_MS, 30 * 60_000, 60_000, 2 * 60 * 60_000),
    maxJobAttempts: parseInteger(process.env.MAX_JOB_ATTEMPTS, 3, 1, 10),
    retryBaseDelayMs: parseInteger(process.env.RETRY_BASE_DELAY_MS, 1_000, 100, 60_000),
    maxBatchBytes: parseSize(process.env.MAX_BATCH_TOTAL_SIZE, 10 * GB, 100 * GB),
    storageDir: process.env.WORKER_STORAGE_DIR || "./storage",
    tempDir: process.env.WORKER_TEMP_DIR || null,
    mediaCookiesFile: process.env.MEDIA_COOKIES_FILE || null,
    ytdlpPath: process.env.YTDLP_PATH || null,
    ytdlpCookiesFromBrowser: process.env.YTDLP_COOKIES_FROM_BROWSER || null,
    ytdlpCookiesForYoutube: parseBoolean(process.env.YTDLP_COOKIES_FOR_YOUTUBE, false),
    ytdlpRetries: parseInteger(process.env.YTDLP_RETRIES, 1, 1, 5),
    ytdlpSocketTimeoutSeconds: parseInteger(process.env.YTDLP_SOCKET_TIMEOUT_SECONDS, 15, 5, 120),
    ytdlpConcurrentFragments: parseInteger(process.env.YTDLP_CONCURRENT_FRAGMENTS, 8, 1, 32),
    ytdlpImpersonate: ytdlpImpersonate.toLowerCase() === "none" ? null : ytdlpImpersonate || null,
    ffmpegPath: process.env.FFMPEG_PATH || null,
    ffprobePath: process.env.FFPROBE_PATH || null,
    ffmpegThreads: parseInteger(process.env.FFMPEG_THREADS, 4, 1, 32),
    // youtubei.js needs an explicitly configured JavaScript evaluator. Keep it
    // off unless the operator has installed and configured one; otherwise every
    // YouTube failure pays for a fallback that cannot succeed.
    youtubeJsEnabled: parseBoolean(process.env.YOUTUBE_JS_ENABLED, false),
    galleryDlEnabled: parseBoolean(process.env.GALLERY_DL_ENABLED, true),
    galleryDlPath: process.env.GALLERY_DL_PATH || null,
    galleryDlRetries: parseInteger(process.env.GALLERY_DL_RETRIES, 1, 1, 5),
    galleryDlHttpTimeoutSeconds: parseInteger(process.env.GALLERY_DL_HTTP_TIMEOUT_SECONDS, 15, 5, 120),
    pageMetadataEnabled: parseBoolean(process.env.PAGE_METADATA_ENABLED, true),
    pageMetadataMaxBytes: parseSize(process.env.PAGE_METADATA_MAX_SIZE, MB, 4 * MB),
    instagramProxyHosts: process.env.INSTAGRAM_PROXY_HOSTS === undefined ? ["www.kkkinstagram.com"] : parseList(process.env.INSTAGRAM_PROXY_HOSTS),
    instagramProxyFirst: parseBoolean(process.env.INSTAGRAM_PROXY_FIRST, false),
    redditProxyHosts: process.env.REDDIT_PROXY_HOSTS === undefined ? ["redditez.com"] : parseList(process.env.REDDIT_PROXY_HOSTS),
    disabledEngines: new Set(parseList(process.env.DISABLED_ENGINES).map((item) => item.toLowerCase())),
    cobaltApiEndpoints: parseList(process.env.COBALT_API_ENDPOINTS),
    cobaltDirectoryEnabled: parseBoolean(process.env.COBALT_DIRECTORY_ENABLED, false),
    cobaltDirectoryUrl: process.env.COBALT_DIRECTORY_URL || "https://cobalt.directory/api/working?type=api&turnstile=0",
    cobaltEndpointTimeoutMs: parseInteger(process.env.COBALT_ENDPOINT_TIMEOUT_MS, 12_000, 3_000, 60_000),
    cobaltMaxEndpoints: parseInteger(process.env.COBALT_MAX_ENDPOINTS, 5, 1, 10),
    cobaltFailureCooldownMs: parseInteger(process.env.COBALT_FAILURE_COOLDOWN_MS, 60_000, 1_000, 10 * 60_000),
    cobaltAuthScheme: process.env.COBALT_AUTH_SCHEME || "Api-Key",
    cobaltApiKey: process.env.COBALT_API_KEY,
    tempPrefix: process.env.TEMP_PREFIX || "mediaworker-",
    userAgent: process.env.HTTP_USER_AGENT || "MediaFilez-Worker/0.1",
    redisUrl: process.env.REDIS_URL || null,
    queuePrefix: process.env.QUEUE_PREFIX || "mediafilez",
    workerConcurrency: parseInteger(process.env.WORKER_CONCURRENCY, 2, 1, 16),
    r2AccountId: process.env.R2_ACCOUNT_ID || null,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || null,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || null,
    r2Bucket: process.env.R2_BUCKET || null,
};

export function requireConfig(keys) {
    const missing = keys.filter((key) => !config[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment value(s): ${missing.join(", ")}`);
    }
}
