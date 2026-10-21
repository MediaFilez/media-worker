import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerRuntime } from "../../src/runtime.ts";
import { config } from "../../src/media-core/config.js";
import { parseApiDownloadJob } from "../../src/jobs/api-contract.ts";

const job = { type: "download", jobId: "hardening", url: "https://example.com/video" };

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-hardening-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = { downloads: 0, stores: 0 };
    const core = {
        async downloadMedia(_url, directory) {
            calls.downloads += 1;
            const filePath = path.join(directory, "clip.mp4");
            await fs.writeFile(filePath, "data");
            return { filePath, fileName: "clip.mp4", sizeBytes: 4, mime: "video/mp4", extension: "mp4", mediaKind: "video" };
        },
        async processMedia(value) {
            return value;
        },
    };
    const storage = {
        async put(value) {
            calls.stores += 1;
            return { key: "result", fileName: value.fileName, sizeBytes: value.sizeBytes, contentType: value.mime, location: "memory://result" };
        },
    };
    const runtime = new WorkerRuntime({ core, storage, tempRoot: root, maxAttempts: 2, retryBaseDelayMs: 1, ...options });
    return { root, core, storage, runtime, calls };
}

test("does no work for an already cancelled job", async (t) => {
    const { runtime, calls, root } = await fixture(t);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await assert.rejects(runtime.execute(job, { signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(calls, { downloads: 0, stores: 0 });
    assert.deepEqual(await fs.readdir(root), []);
});

test("the whole-job deadline interrupts retry backoff", async (t) => {
    const { runtime, core, calls, root } = await fixture(t, { timeoutMs: 40, retryBaseDelayMs: 150 });
    const download = core.downloadMedia;
    core.downloadMedia = async (...args) => {
        if (calls.downloads === 0) {
            calls.downloads += 1;
            throw new Error("transient");
        }
        return download(...args);
    };
    await assert.rejects(runtime.execute(job), { name: "TimeoutError" });
    assert.deepEqual(calls, { downloads: 1, stores: 0 });
    assert.deepEqual(await fs.readdir(root), []);
});

test("removes failed attempt files before retry backoff", async (t) => {
    const { runtime, core, calls, root } = await fixture(t);
    const download = core.downloadMedia;
    core.downloadMedia = async (...args) => {
        const value = await download(...args);
        if (calls.downloads === 1) throw new Error("transient");
        return value;
    };
    const retryDirectories = [];
    const result = await runtime.execute(job, {
        onProgress: async (update) => {
            if (update.phase === "retrying") retryDirectories.push(await fs.readdir(root));
        },
    });
    assert.equal(result.attempts, 2);
    assert.deepEqual(retryDirectories, [[]]);
});

test("progress failures cannot duplicate a committed upload", async (t) => {
    const { runtime, calls, root } = await fixture(t);
    const result = await runtime.execute(job, {
        onProgress: async (update) => {
            if (update.phase === "completed") throw new Error("progress transport failed");
        },
    });
    assert.equal(result.output.key, "result");
    assert.deepEqual(calls, { downloads: 1, stores: 1 });
    assert.deepEqual(await fs.readdir(root), []);
});

test("cancellation after download prevents processing and storage", async (t) => {
    const { runtime, core, calls } = await fixture(t);
    const controller = new AbortController();
    const download = core.downloadMedia;
    core.downloadMedia = async (...args) => {
        const value = await download(...args);
        controller.abort(new DOMException("cancelled", "AbortError"));
        return value;
    };
    core.processMedia = async () => {
        assert.fail("processing must not start");
    };
    await assert.rejects(runtime.execute({ ...job, output: { type: "audio" } }, { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls.stores, 0);
});

test("audio-only quality also selects audio processing for direct video", async (t) => {
    const { runtime, core } = await fixture(t);
    let processed = false;
    core.processMedia = async (value, options) => {
        assert.equal(options.outputType, "audio");
        processed = true;
        return { ...value, mediaKind: "audio", mime: "audio/mpeg", fileName: "audio.mp3" };
    };
    const result = await runtime.execute({ ...job, output: { quality: "audio-only" } });
    assert.equal(processed, true);
    assert.equal(result.output.contentType, "audio/mpeg");
});

test("rejects incompatible audio-only formats without changing contract version 1", () => {
    for (const format of ["mp4", "jpg"]) {
        assert.throws(
            () => parseApiDownloadJob({ ...job, contractVersion: 1, userId: null, output: { quality: "audio-only", format } }),
            /audio-only/,
        );
    }
    assert.equal(
        parseApiDownloadJob({ ...job, contractVersion: 1, userId: null, output: { quality: "audio-only", format: "mp3" } }).payload.contractVersion,
        1,
    );
});

test("rejects processed batch output above the aggregate limit before storage", async (t) => {
    const oldLimit = config.maxBatchBytes;
    config.maxBatchBytes = 8;
    t.after(() => {
        config.maxBatchBytes = oldLimit;
    });
    const { runtime, core, calls } = await fixture(t);
    core.processMedia = async (value) => {
        await fs.writeFile(value.filePath, Buffer.alloc(10));
        return { ...value, sizeBytes: 10 };
    };
    await assert.rejects(
        runtime.execute({ type: "batch", jobId: "batch", items: [{ url: job.url, output: { type: "video" } }] }),
        (error) => error.code === "BATCH_TOO_LARGE",
    );
    assert.equal(calls.stores, 0);
    assert.equal(calls.downloads, 1);
});
