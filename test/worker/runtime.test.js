import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerRuntime } from "../../src/runtime.ts";

function artifact(filePath) {
    return {
        filePath,
        fileName: "clip.mp4",
        sizeBytes: 4,
        mime: "video/mp4",
        extension: "mp4",
        mediaKind: "video",
    };
}

test("executes a serializable download job through Core and storage", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-runtime-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const core = {
        resolveMedia: async () => ({ url: "", outputType: "auto", engines: [] }),
        inspectMedia: async () => ({}),
        async downloadMedia(_url, directory) {
            calls.push("download");
            await fs.mkdir(directory, { recursive: true });
            const filePath = path.join(directory, "clip.mp4");
            await fs.writeFile(filePath, "data");
            return artifact(filePath);
        },
        async processMedia(value) {
            calls.push("process");
            return value;
        },
    };
    const storage = {
        async put(value) {
            calls.push("store");
            return {
                key: "result/clip.mp4",
                sizeBytes: value.sizeBytes,
                contentType: value.mime,
                fileName: value.fileName,
                location: "memory://result/clip.mp4",
            };
        },
        async delete() {},
    };
    const progress = [];
    const runtime = new WorkerRuntime({ core, storage, tempRoot: root, maxAttempts: 1 });
    const result = await runtime.execute(
        {
            type: "download",
            jobId: "job_123",
            url: "https://example.com/video",
            output: { type: "video", format: "mp4", quality: "720p", allowCompression: false },
        },
        { onProgress: (update) => progress.push(update.phase) },
    );

    assert.deepEqual(calls, ["download", "process", "store"]);
    assert.equal(result.output.key, "result/clip.mp4");
    assert.equal(result.attempts, 1);
    assert.ok(progress.includes("storing"));
    assert.ok(progress.includes("completed"));
});

test("retries a transient failure but not malformed jobs", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-retry-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let attempts = 0;
    const core = {
        resolveMedia: async () => ({ url: "", outputType: "auto", engines: [] }),
        inspectMedia: async () => ({}),
        async downloadMedia(_url, directory) {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary upstream failure");
            await fs.mkdir(directory, { recursive: true });
            const filePath = path.join(directory, "clip.mp4");
            await fs.writeFile(filePath, "data");
            return artifact(filePath);
        },
        async processMedia(value) {
            return value;
        },
    };
    const storage = {
        async put(value) {
            return {
                key: "ok",
                sizeBytes: 4,
                contentType: value.mime,
                fileName: value.fileName,
                location: "memory://ok",
            };
        },
        async delete() {},
    };
    const runtime = new WorkerRuntime({ core, storage, tempRoot: root, maxAttempts: 2, retryBaseDelayMs: 1 });
    const result = await runtime.execute({
        type: "download",
        jobId: "retry_1",
        url: "https://example.com/video",
    });

    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
    await assert.rejects(() => runtime.execute({ type: "download", jobId: "bad", url: "ftp://example.com/file" }));
    assert.equal(attempts, 2);
});

test("creates batch item directories before checking disk space", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-batch-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const core = {
        resolveMedia: async () => ({ url: "", outputType: "auto", engines: [] }),
        inspectMedia: async () => ({}),
        async downloadMedia(_url, directory) {
            const filePath = path.join(directory, "clip.mp4");
            await fs.writeFile(filePath, "data");
            return artifact(filePath);
        },
        async processMedia(value) {
            return value;
        },
    };
    const storage = {
        async put(value) {
            return {
                key: "batch/result.zip",
                sizeBytes: value.sizeBytes,
                contentType: value.mime,
                fileName: value.fileName,
                location: "memory://batch/result.zip",
            };
        },
        async delete() {},
    };
    const runtime = new WorkerRuntime({ core, storage, tempRoot: root, maxAttempts: 1 });
    const result = await runtime.execute({
        type: "batch",
        jobId: "batch_123",
        archiveName: "media.zip",
        items: [{ url: "https://example.com/video" }],
    });

    assert.equal(result.output.key, "batch/result.zip");
});
