import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalStorageAdapter } from "../../src/storage/local.ts";
import { R2StorageAdapter } from "../../src/storage/r2.ts";

test("stores atomically inside the configured root with generated keys", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-storage-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source.mp4");
    await fs.writeFile(source, "media");
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    const artifact = {
        filePath: source,
        fileName: "source.mp4",
        sizeBytes: 5,
        mime: "video/mp4",
        extension: "mp4",
        mediaKind: "video",
    };

    const stored = await storage.put(artifact);
    assert.equal(await fs.readFile(stored.location, "utf8"), "media");
    assert.match(stored.key, /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]+-source\.mp4$/);
    const second = await storage.put(artifact);
    assert.notEqual(second.key, stored.key);
    await assert.rejects(() => storage.put(artifact, { public: true }), /dedicated R2 bucket/);
});

test("places public media in the dedicated R2 bucket with inline media headers", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-r2-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "clip.mp4");
    await fs.writeFile(source, "media");
    const storage = new R2StorageAdapter({
        accountId: "account",
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "private-bucket",
        publicBucket: "public-bucket",
    });
    let input;
    storage.client = {
        send: async (command) => {
            input = command.input;
        },
    };
    const result = await storage.put({ filePath: source, fileName: "clip.mp4", sizeBytes: 5, mime: "video/mp4" }, { public: true });
    assert.equal(input.Bucket, "public-bucket");
    assert.equal(input.ContentType, "video/mp4");
    assert.equal(input.ContentDisposition, "inline");
    assert.equal(input.ContentLength, 5);
    assert.match(result.location, /^r2:\/\/public-bucket\//);
});
