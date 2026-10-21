import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createQueueProcessor } from "../../src/queue-processor.ts";
import { WorkerRuntime } from "../../src/runtime.ts";
import { LocalStorageAdapter } from "../../src/storage/local.ts";

// Only an explicitly supplied test server is used. Never fall back to production REDIS_URL.
const redisUrl = process.env.TEST_REDIS_URL;
test("real Redis: redelivery recovery, cancellation and failed control connection", { skip: !redisUrl, timeout: 30_000 }, async (t) => {
    const prefix = `mediaworker-test-${crypto.randomUUID()}`;
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const control = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 1000 });
    const queue = new Queue("download", { prefix, connection });
    const events = new QueueEvents("download", { prefix, connection });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-redis-"));
    const source = path.join(root, "source.png");
    await fs.writeFile(source, "fixture");
    let downloads = 0;
    const runtime = new WorkerRuntime({
        tempRoot: path.join(root, "temp"),
        maxAttempts: 1,
        storage: new LocalStorageAdapter(path.join(root, "storage")),
        core: {
            downloadMedia: async () => {
                downloads++;
                return { filePath: source, fileName: "source.png", sizeBytes: 7, mime: "image/png", mediaKind: "image", extension: "png" };
            },
        },
    });
    const processor = createQueueProcessor(runtime, control, { prefix, maxAttempts: 2, pollMs: 20 });
    const worker = new Worker("download", processor.processJob, { prefix, connection });
    t.after(async () => {
        processor.shutdown();
        await worker.close(true);
        await events.close();
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.del(`${prefix}:cancel:cancelled`);
        connection.disconnect();
        control.disconnect();
        await fs.rm(root, { recursive: true, force: true });
    });
    worker.on("error", () => {});
    control.on("error", () => {});
    await Promise.all([
        worker.waitUntilReady(),
        events.waitUntilReady(),
        new Promise((resolve) => (control.status === "ready" ? resolve() : control.once("ready", resolve))),
    ]);
    const payload = { contractVersion: 1, userId: null, type: "download", jobId: "stable", url: "https://example.com/fixture" };
    const first = await queue.add("download", payload);
    const firstResult = await first.waitUntilFinished(events, 10_000);
    const redelivery = await queue.add("download", payload);
    const secondResult = await redelivery.waitUntilFinished(events, 10_000);
    assert.deepEqual(secondResult.output, firstResult.output);
    assert.equal(downloads, 1);
    await connection.set(`${prefix}:cancel:cancelled`, "1", "PX", 60_000);
    const cancelled = await queue.add("download", { ...payload, jobId: "cancelled" }, { attempts: 5 });
    await assert.rejects(cancelled.waitUntilFinished(events, 10_000), /Job cancelled/);
    assert.equal((await queue.getJob(cancelled.id)).attemptsMade, 1);
    assert.equal(downloads, 1);
    control.disconnect();
    const unavailable = await queue.add("download", { ...payload, jobId: "redis-failure" }, { attempts: 100, backoff: { type: "fixed", delay: 10 } });
    await assert.rejects(unavailable.waitUntilFinished(events, 10_000), /cancellation service is unavailable/);
    assert.equal((await queue.getJob(unavailable.id)).attemptsMade, 2);
    assert.equal(downloads, 1);
});
