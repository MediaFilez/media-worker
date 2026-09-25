import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupStaleTempDirs, cleanupTempDir, createRequestTempDir } from "../../src/media-core/utils/temp.js";

test("request temp directories include a process-lifetime owner identity", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-owner-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const dir = await createRequestTempDir({ rootDir: root, prefix: "mediafilez-" });

    assert.match(path.basename(dir), /^mediafilez-[a-f0-9]{12}-[a-f0-9]{32}-/);
    assert.equal(await cleanupStaleTempDirs({ rootDir: root, prefix: "mediafilez-" }), 0);
    await fs.access(dir);
    await cleanupTempDir(dir);
});

test("startup cleanup removes only directories whose owner lock is gone", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cleanup-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const stale = path.join(root, `mediafilez-${"a".repeat(12)}-${"b".repeat(32)}-job-one`);
    const active = path.join(root, `mediafilez-${"a".repeat(12)}-${"c".repeat(32)}-job-two`);
    const legacy = path.join(root, "mediafilez-job-legacy");
    const unrelated = path.join(root, "unrelated-job");
    const matchingFile = path.join(root, "mediafilez-not-a-directory");
    await Promise.all([fs.mkdir(stale), fs.mkdir(active), fs.mkdir(legacy), fs.mkdir(unrelated), fs.writeFile(matchingFile, "keep")]);

    const removed = await cleanupStaleTempDirs({
        rootDir: root,
        prefix: "mediafilez-",
        isOwnerActive: ({ ownerId }) => ownerId === "c".repeat(32),
    });

    assert.equal(removed, 1);
    await assert.rejects(fs.access(stale), { code: "ENOENT" });
    await fs.access(active);
    await fs.access(legacy);
    await fs.access(unrelated);
    await fs.access(matchingFile);
});

test("startup cleanup preserves an owner whose event loop is paused", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-owner-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const tempModuleUrl = new URL("../../src/media-core/utils/temp.js", import.meta.url).href;
    const program = `
        import { createRequestTempDir } from ${JSON.stringify(tempModuleUrl)};
        const dir = await createRequestTempDir({ rootDir: process.argv[1], prefix: "mediafilez-" });
        console.log(dir);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program, root], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
        if (child.exitCode === null) child.kill();
    });

    const dir = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The temp owner did not start.")), 3_000);
        child.once("error", reject);
        child.stdout.once("data", (chunk) => {
            clearTimeout(timeout);
            resolve(chunk.toString("utf8").trim());
        });
    });

    assert.equal(await cleanupStaleTempDirs({ rootDir: root, prefix: "mediafilez-" }), 0);
    await fs.access(dir);
    await once(child, "exit");
    assert.equal(await cleanupStaleTempDirs({ rootDir: root, prefix: "mediafilez-" }), 1);
    await assert.rejects(fs.access(dir), { code: "ENOENT" });
});
