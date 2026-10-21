import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { LocalStorageAdapter } from "../../src/storage/local.ts";
import { R2StorageAdapter } from "../../src/storage/r2.ts";
import { storageIdentity } from "../../src/storage/identity.ts";
import { WorkerRuntime } from "../../src/runtime.ts";
import { withJobResources } from "../../src/media-core/utils/resources.js";
import { createRequestTempDir } from "../../src/media-core/utils/temp.js";

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-identity-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filePath = path.join(root, "source.png");
    await fs.writeFile(filePath, "media");
    return { root, artifact: { filePath, fileName: "source.png", sizeBytes: 5, mime: "image/png", mediaKind: "image", extension: "png" } };
}

test("concurrent local commits reuse the first complete result without overwriting", async (t) => {
    const { root, artifact } = await fixture(t);
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    const identity = storageIdentity({ jobId: "same-job", url: "https://example.com/" }, "original");
    const results = await Promise.all(Array.from({ length: 6 }, () => storage.put(artifact, { identity })));
    assert.equal(new Set(results.map((result) => result.key)).size, 1);
    await fs.writeFile(artifact.filePath, "other");
    assert.deepEqual(await storage.put(artifact, { identity }), results[0]);
    assert.equal(await fs.readFile(results[0].location, "utf8"), "media");
    assert.deepEqual(await fs.readdir(path.join(root, "stored", "jobs")), [results[0].key.split("/")[1]]);
    await assert.rejects(storage.put(artifact, { identity: { ...identity, fingerprint: "different" } }), { code: "IDENTITY_CONFLICT" });
});

test("a fresh runtime recovers a result committed before acknowledgement", async (t) => {
    const { root, artifact } = await fixture(t);
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    let downloads = 0;
    const core = {
        downloadMedia: async () => {
            downloads++;
            return artifact;
        },
    };
    const job = { type: "download", jobId: "ack-lost", url: "https://example.com/file" };
    const options = { core, storage, tempRoot: path.join(root, "temp"), maxAttempts: 1 };
    const first = await new WorkerRuntime(options).execute(job);
    const second = await new WorkerRuntime({ ...options, storage: new LocalStorageAdapter(storage.rootDir) }).execute(job);
    assert.deepEqual(second.output, first.output);
    assert.equal(downloads, 1);
    await assert.rejects(new WorkerRuntime(options).execute({ ...job, url: "https://example.com/different" }), { code: "IDENTITY_CONFLICT" });
    assert.equal(downloads, 1);
});

test("R2 conditional commits recover a lost response and select the correct delete bucket", async (t) => {
    const { artifact } = await fixture(t);
    const storage = new R2StorageAdapter({
        accountId: "account",
        accessKeyId: "test",
        secretAccessKey: "test",
        bucket: "private",
        publicBucket: "public",
    });
    const objects = new Map();
    let puts = 0;
    const deletes = [];
    storage.client = {
        send: async (command) => {
            const input = command.input;
            const key = `${input.Bucket}/${input.Key}`;
            if (command.constructor.name === "HeadObjectCommand") {
                if (!objects.has(key)) throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
                return objects.get(key);
            }
            if (command.constructor.name === "DeleteObjectCommand") {
                deletes.push(input);
                objects.delete(key);
                return {};
            }
            assert.equal(input.IfNoneMatch, "*");
            puts++;
            if (objects.has(key)) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
            objects.set(key, { ContentLength: input.ContentLength, ContentType: input.ContentType, Metadata: input.Metadata });
            throw new Error("Upload committed but response lost");
        },
    };
    const identity = storageIdentity({ jobId: "r2-ack-lost" }, "original");
    const first = await storage.put(artifact, { identity, public: true });
    assert.deepEqual(await storage.put(artifact, { identity, public: true }), first);
    assert.equal(puts, 1);
    const thumbnail = await storage.put(artifact, { identity: { ...identity, role: "thumbnail" }, public: true });
    assert.notEqual(thumbnail.key, first.key);
    await storage.delete(first.key, { public: true });
    await storage.delete(thumbnail.key, { public: true });
    await storage.delete("legacy-private");
    assert.deepEqual(
        deletes.map((input) => input.Bucket),
        ["public", "public", "private"],
    );
});

test("R2 concurrent create-only writes cannot overwrite the winning object", async (t) => {
    const { artifact } = await fixture(t);
    const storage = new R2StorageAdapter({ accountId: "account", accessKeyId: "test", secretAccessKey: "test", bucket: "private" });
    let object;
    let firstHeads = 0;
    let release;
    const barrier = new Promise((resolve) => {
        release = resolve;
    });
    let commits = 0;
    storage.client = {
        send: async (command) => {
            const input = command.input;
            if (command.constructor.name === "HeadObjectCommand") {
                if (++firstHeads <= 2) {
                    if (firstHeads === 2) release();
                    await barrier;
                    throw Object.assign(new Error("not found"), { $metadata: { httpStatusCode: 404 } });
                }
                return object;
            }
            assert.equal(input.IfNoneMatch, "*");
            if (object) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } });
            object = { ContentLength: input.ContentLength, ContentType: input.ContentType, Metadata: input.Metadata };
            commits++;
            return {};
        },
    };
    const identity = storageIdentity({ jobId: "r2-race" }, "original");
    const results = await Promise.all([storage.put(artifact, { identity }), storage.put(artifact, { identity })]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(commits, 1);
});

test("cancelled local commits leave no complete object or staging file", async (t) => {
    const { root, artifact } = await fixture(t);
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    const controller = new AbortController();
    controller.abort(new Error("cancel upload"));
    await assert.rejects(
        storage.put(artifact, { signal: controller.signal, identity: storageIdentity({ jobId: "cancelled" }, "original") }),
        /cancel upload/,
    );
    await assert.rejects(fs.stat(storage.rootDir), { code: "ENOENT" });
});

test("local storage staging participates in the job disk budget before commit", async (t) => {
    const { root, artifact } = await fixture(t);
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    const jobDir = path.join(root, "job");
    await fs.mkdir(jobDir);
    await fs.writeFile(path.join(jobDir, "download"), Buffer.alloc(50));
    const identity = storageIdentity({ jobId: "storage-budget" }, "original");
    await assert.rejects(
        withJobResources(jobDir, new AbortController().signal, (signal) => storage.put(artifact, { signal, identity }), { maxTempBytes: 51 }),
        { code: "TEMP_LIMIT" },
    );
    assert.equal(await storage.find({ identity }), null);
    assert.deepEqual(await fs.readdir(path.join(storage.rootDir, "jobs")), []);
});

test("local storage startup removes abandoned staging while preserving a live owner", async (t) => {
    const { root, artifact } = await fixture(t);
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    const jobs = path.join(storage.rootDir, "jobs");
    await fs.mkdir(jobs, { recursive: true });
    const host = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12);
    const abandoned = path.join(jobs, `mediaworker-storage-${host}-${"0".repeat(32)}-abandoned`);
    await fs.mkdir(abandoned);
    await fs.writeFile(path.join(abandoned, "partial"), "incomplete");
    const live = await createRequestTempDir({ rootDir: jobs, prefix: "mediaworker-storage-" });
    await storage.put(artifact, { identity: storageIdentity({ jobId: "staging-cleanup" }, "original") });
    await assert.rejects(fs.stat(abandoned), { code: "ENOENT" });
    assert.equal((await fs.stat(live)).isDirectory(), true);
});
