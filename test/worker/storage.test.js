import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalStorageAdapter } from "../../src/storage/local.ts";

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
});
