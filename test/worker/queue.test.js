import assert from "node:assert/strict";
import test from "node:test";
import { UnrecoverableError } from "bullmq";
import { createQueueProcessor } from "../../src/queue-processor.ts";
import { userError } from "../../src/media-core/utils/errors.js";
import { shutdownQueueWorker } from "../../src/queue-shutdown.ts";

function job(overrides = {}) {
    return {
        data: { contractVersion: 1, type: "download", jobId: "queue-test", userId: null, url: "https://example.com/media" },
        attemptsMade: 0,
        updateProgress: async () => {},
        ...overrides,
    };
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("queue rejects invalid contracts and permanent download failures without retries", async () => {
    let calls = 0;
    const processor = createQueueProcessor(
        {
            execute: async () => {
                calls++;
                throw userError("Private URL", "PRIVATE_URL", { stopFallback: true });
            },
        },
        { get: async () => null },
    );
    await assert.rejects(processor.processJob(job({ data: {} })), UnrecoverableError);
    assert.equal(calls, 0);
    await assert.rejects(processor.processJob(job()), UnrecoverableError);
    assert.equal(calls, 1);
});

test("queue distinguishes explicit cancellation from a Redis failure", async () => {
    const runtime = { execute: async () => assert.fail("must not start") };
    await assert.rejects(
        createQueueProcessor(runtime, { get: async () => "1" }).processJob(job()),
        (error) => error instanceof UnrecoverableError && error.message === "Job cancelled.",
    );
    await assert.rejects(
        createQueueProcessor(runtime, {
            get: async () => {
                throw new Error("Redis disconnected");
            },
        }).processJob(job()),
        { code: "CONTROL_UNAVAILABLE" },
    );
});

test("serial cancellation polling never overlaps and aborts on Redis failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const secondRead = deferred();
    const started = deferred();
    let reads = 0;
    const processor = createQueueProcessor(
        {
            execute: async (_job, { signal }) => {
                started.resolve();
                return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
            },
        },
        { get: async () => (++reads === 1 ? null : secondRead.promise) },
        { pollMs: 500 },
    );
    const outcome = assert.rejects(processor.processJob(job()), { code: "CONTROL_UNAVAILABLE" });
    await started.promise;
    t.mock.timers.tick(500);
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(reads, 2);
    secondRead.reject(new Error("Redis disconnected"));
    await outcome;
    t.mock.timers.tick(5000);
    assert.equal(reads, 2);
});

test("shutdown aborts an active job and rejects new deliveries as retryable", async () => {
    const started = deferred();
    let calls = 0;
    const processor = createQueueProcessor(
        {
            execute: async (_job, { signal }) => {
                calls++;
                started.resolve();
                return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
            },
        },
        { get: async () => null },
    );
    const outcome = assert.rejects(processor.processJob(job()), { code: "WORKER_SHUTDOWN" });
    await started.promise;
    processor.shutdown();
    await outcome;
    await assert.rejects(processor.processJob(job()), { code: "WORKER_SHUTDOWN" });
    assert.equal(calls, 1);
});

test("worker retry cap stops producer-supplied attempts from causing unbounded retries", async () => {
    const processor = createQueueProcessor(
        {
            execute: async () => {
                throw new Error("Temporary storage outage");
            },
        },
        { get: async () => null },
        { maxAttempts: 2 },
    );
    await assert.rejects(processor.processJob(job()), (error) => !(error instanceof UnrecoverableError));
    await assert.rejects(processor.processJob(job({ attemptsMade: 1, opts: { attempts: 1000 } })), UnrecoverableError);
});

test("a Redis failure after successful storage cannot turn completion into failure", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const uploaded = deferred();
    const secondRead = deferred();
    let reads = 0;
    const expected = { output: { key: "stable-object" } };
    const processor = createQueueProcessor(
        { execute: async () => uploaded.promise },
        { get: async () => (++reads === 1 ? null : secondRead.promise) },
    );
    const outcome = processor.processJob(job());
    await flush();
    t.mock.timers.tick(500);
    await flush();
    uploaded.resolve(expected);
    await flush();
    secondRead.reject(new Error("Redis disconnected after upload"));
    assert.deepEqual(await outcome, expected);
    t.mock.timers.tick(5000);
    assert.equal(reads, 2);
});

test("shutdown bounds an unavailable queue connection and releases control Redis", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events = [];
    const stopped = assert.rejects(
        shutdownQueueWorker(
            {
                close: () => {
                    events.push("close");
                    return new Promise(() => {});
                },
            },
            { disconnect: () => events.push("disconnect") },
            { shutdown: () => events.push("abort") },
            1000,
        ),
        /grace period/,
    );
    t.mock.timers.tick(1000);
    await stopped;
    assert.deepEqual(events, ["abort", "close", "disconnect"]);
});

test("stalled progress writes cannot block execution or queue more progress commands", async () => {
    let updates = 0;
    const expected = { output: { key: "completed" } };
    const processor = createQueueProcessor(
        {
            execute: async (_job, { onProgress }) => {
                await onProgress({ phase: "downloading" });
                await onProgress({ phase: "storing" });
                await onProgress({ phase: "completed" });
                return expected;
            },
        },
        { get: async () => null },
    );
    const result = await processor.processJob(
        job({
            updateProgress: async () => {
                updates++;
                return new Promise(() => {});
            },
        }),
    );
    assert.deepEqual(result, expected);
    assert.equal(updates, 1);
});
