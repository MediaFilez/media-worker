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

test("stores a public video thumbnail without changing the original artifact", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-preview-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    const core = {
        async downloadMedia(_url, directory) {
            const filePath = path.join(directory, "clip.mp4");
            await fs.writeFile(filePath, "data");
            return artifact(filePath);
        },
        async processMedia(value, options) {
            assert.equal(options.outputType, "thumbnail");
            assert.equal(options.maxOutputBytes, 2 * 1024 * 1024);
            assert.equal(options.allowCompression, true);
            calls.push("thumbnail");
            return { ...value, fileName: "thumbnail.jpg", mime: "image/jpeg", mediaKind: "image", sizeBytes: 2 };
        },
    };
    const storage = {
        async put(value, options) {
            calls.push(value.fileName);
            assert.equal(options.public, true);
            return {
                key: `2026-09-27/${value.fileName}`,
                fileName: value.fileName,
                sizeBytes: value.sizeBytes,
                contentType: value.mime,
                location: `memory://${value.fileName}`,
            };
        },
    };
    const runtime = new WorkerRuntime({ core, storage, tempRoot: root, maxAttempts: 1 });
    const result = await runtime.execute({ type: "download", jobId: "preview_1", url: "https://example.com/video", delivery: "public" });

    assert.deepEqual(calls, ["clip.mp4", "thumbnail", "thumbnail.jpg"]);
    assert.equal(result.output.key, "2026-09-27/clip.mp4");
    assert.equal(result.output.thumbnailKey, "2026-09-27/thumbnail.jpg");
});

test("delivers the original public video when thumbnail extraction fails", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-preview-fallback-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const core = {
        async downloadMedia(_url, directory) {
            const filePath = path.join(directory, "clip.mp4");
            await fs.writeFile(filePath, "data");
            return artifact(filePath);
        },
        async processMedia() {
            throw new Error("thumbnail unavailable");
        },
    };
    const storage = {
        async put(value) {
            return { key: "2026-09-27/clip.mp4", fileName: value.fileName, sizeBytes: value.sizeBytes, contentType: value.mime };
        },
    };
    const runtime = new WorkerRuntime({ core, storage, tempRoot: root, maxAttempts: 1 });
    const result = await runtime.execute({ type: "download", jobId: "preview_fallback", url: "https://example.com/video", delivery: "public" });
    assert.equal(result.output.key, "2026-09-27/clip.mp4");
    assert.equal(result.output.thumbnailKey, undefined);
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
