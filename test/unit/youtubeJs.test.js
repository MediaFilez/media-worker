import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveStream } from "../../src/media-core/download/engines/youtubeJs.js";

test("retries YouTube.js client initialization after a transient failure", async () => {
    const { getClient } = await import(`../../src/media-core/download/engines/youtubeJs.js?retry-test=${Date.now()}`);
    const client = { ready: true };
    let attempts = 0;
    const createClient = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary network failure");
        return client;
    };

    await assert.rejects(getClient(createClient), /temporary network failure/);
    assert.equal(await getClient(createClient), client);
    assert.equal(attempts, 2);
});

test("does not expose an interrupted YouTube.js download as a finished file", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-youtube-js-"));
    const filePath = path.join(dir, "video.mp4");
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    async function* interruptedStream() {
        yield Buffer.from("partial media");
        throw new Error("connection lost");
    }

    await assert.rejects(saveStream(interruptedStream(), filePath, 1024, {}), /connection lost/);
    await assert.rejects(fs.access(filePath), { code: "ENOENT" });
});

test("cancels a stalled YouTube.js stream when the job is aborted", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-youtube-js-"));
    const filePath = path.join(dir, "video.mp4");
    const controller = new AbortController();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    const stream = new ReadableStream({
        start(streamController) {
            streamController.enqueue(Buffer.from("partial media"));
        },
    });
    setTimeout(() => controller.abort(), 10).unref();

    const outcome = await Promise.race([
        saveStream(stream, filePath, 1024, { signal: controller.signal }).then(
            () => "resolved",
            (error) => error.name,
        ),
        new Promise((resolve) => setTimeout(() => resolve("stalled"), 250)),
    ]);

    assert.equal(outcome, "AbortError");
    await assert.rejects(fs.access(filePath), { code: "ENOENT" });
});
