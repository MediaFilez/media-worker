import { UnrecoverableError, Worker, type ConnectionOptions, type Job } from "bullmq";
import { Redis } from "ioredis";
import { config } from "./media-core/config.js";
import { WorkerRuntime } from "./runtime.js";
import { parseApiDownloadJob } from "./jobs/api-contract.js";

if (!config.redisUrl) throw new Error("REDIS_URL is required to run the queue worker.");
const connection = redisConnection(config.redisUrl);
const control = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const runtime = new WorkerRuntime({ maxAttempts: 1 });

const worker = new Worker(
    "download",
    async (job: Job) => {
        const { payload, runtimeJob } = parseApiDownloadJob(job.data);
        const controller = new AbortController();
        const cancelKey = `${config.queuePrefix}:cancel:${payload.jobId}`;
        const checkCancellation = async () => {
            if ((await control.get(cancelKey)) !== "1") return;
            controller.abort(Object.assign(new Error("Job cancelled."), { name: "AbortError" }));
        };
        await checkCancellation();
        const poll = setInterval(() => void checkCancellation().catch((error: unknown) => controller.abort(error)), 500);
        try {
            try {
                return await runtime.execute(runtimeJob, { signal: controller.signal, onProgress: (update) => job.updateProgress(update) });
            } catch (error) {
                if (controller.signal.aborted) throw new UnrecoverableError("Job cancelled.");
                throw error;
            }
        } finally {
            clearInterval(poll);
            if (!controller.signal.aborted) await control.del(cancelKey);
        }
    },
    { connection, prefix: config.queuePrefix, concurrency: config.workerConcurrency },
);

worker.on("failed", (job, error) => console.error(JSON.stringify({ level: "error", jobId: job?.id, message: error.message })));
worker.on("error", (error) => console.error(JSON.stringify({ level: "error", message: error.message })));

async function shutdown() {
    await worker.close();
    await control.quit();
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
