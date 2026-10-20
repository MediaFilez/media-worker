import { Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./media-core/config.js";
import { WorkerRuntime } from "./runtime.js";
import { createQueueProcessor } from "./queue-processor.js";
import { redactSensitive } from "./media-core/utils/errors.js";
import { shutdownQueueWorker } from "./queue-shutdown.js";
import { randomUUID } from "node:crypto";
import { validateCookieFile } from "./startup.js";

if (!config.redisUrl) throw new Error("REDIS_URL is required to run the queue worker.");
await validateCookieFile(config.mediaCookiesFile);
const connection = redisConnection(config.redisUrl);
const control = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 2_000, lazyConnect: true });
const runtime = new WorkerRuntime({ maxAttempts: 1 });
const processor = createQueueProcessor(runtime, control);

const worker = new Worker("download", processor.processJob, { connection, prefix: config.queuePrefix, concurrency: config.workerConcurrency });

worker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", jobId: job?.id, message: redactSensitive(error.message) })));
worker.on("error", (error) => console.error(JSON.stringify({ level: "error", message: redactSensitive(error.message) })));
control.on("error", (error) =>
    console.error(JSON.stringify({ level: "error", event: "redis.control.failed", message: redactSensitive(error.message) })),
);
await control.connect();
await worker.waitUntilReady();
const workerId = randomUUID();
const heartbeatKey = `${config.queuePrefix}:workers`;
const heartbeat = async () => {
    await control.zadd(heartbeatKey, Date.now(), workerId);
    await control.zremrangebyscore(heartbeatKey, "-inf", Date.now() - 120_000);
    await control.expire(heartbeatKey, 120);
};
await heartbeat();
const heartbeatTimer = setInterval(
    () =>
        void heartbeat().catch(() => {
            console.error(JSON.stringify({ level: "error", event: "worker.heartbeat.failed" }));
        }),
    15_000,
);
heartbeatTimer.unref();

let shuttingDown: Promise<void> | undefined;
function shutdown() {
    clearInterval(heartbeatTimer);
    shuttingDown ??= shutdownQueueWorker(worker, control, processor, config.shutdownGraceMs).catch((error: unknown) => {
        console.error(JSON.stringify({ level: "error", event: "worker.shutdown.failed", message: redactSensitive(String(error)) }));
        // A disconnected Redis acknowledgement may hold BullMQ open indefinitely.
        // The process supervisor restarts it; stable storage identity protects redelivery.
        process.exit(1);
    });
    return shuttingDown;
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function redisConnection(url: string): ConnectionOptions {
    const parsed = new URL(url);
    return {
        host: parsed.hostname,
        port: Number(parsed.port || 6379),
        db: Number(parsed.pathname.slice(1) || 0),
        maxRetriesPerRequest: null,
        ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
        ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
        ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    };
}
