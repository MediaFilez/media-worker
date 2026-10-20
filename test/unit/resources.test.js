import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withJobResources, acquireProcess, jobResources } from "../../src/media-core/utils/resources.js";
import { runProcess } from "../../src/media-core/utils/process.js";

async function directory(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-resource-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test("sampled aggregate disk limit aborts and kills a running child", async (t) => {
    const root = await directory(t);
    await assert.rejects(
        withJobResources(
            root,
            new AbortController().signal,
            async (signal) => {
                const child = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal });
                const rejection = assert.rejects(child, (error) => error.aborted);
                await fs.writeFile(path.join(root, "large.part"), Buffer.alloc(100));
                await rejection;
            },
            { maxTempBytes: 50, pollMs: 5 },
        ),
        { code: "TEMP_LIMIT" },
    );
});

test("process slots serialize launches and remove cancelled waiters", async (t) => {
    const root = await directory(t);
    await withJobResources(
        root,
        new AbortController().signal,
        async (signal) => {
            const release = await acquireProcess(signal);
            const controller = new AbortController();
            const waiting = acquireProcess(controller.signal);
            controller.abort(new Error("waiting cancelled"));
            await assert.rejects(waiting, /waiting cancelled/);
            assert.equal(jobResources().waiters.length, 0);
            let acquired = false;
            const next = acquireProcess(signal).then((nextRelease) => {
                acquired = true;
                return nextRelease;
            });
            await Promise.resolve();
            assert.equal(acquired, false);
            release();
            const nextRelease = await next;
            assert.equal(jobResources().processes, 1);
            nextRelease();
            assert.equal(jobResources().processes, 0);
        },
        { maxProcesses: 1 },
    );
});

test("pre-aborted process does not launch and timed-out process terminates", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await assert.rejects(runProcess("missing-tool", [], { signal: controller.signal }), /already cancelled/);
    await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 }), (error) => error.timedOut);
});

test("job completion terminates and reaps a child left running by an adapter", async (t) => {
    const root = await directory(t);
    let stopped;
    await withJobResources(root, new AbortController().signal, async (signal) => {
        const child = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal });
        stopped = assert.rejects(child, (error) => error.aborted);
        // Yield until the process has registered its close handler.
        await Promise.resolve();
    });
    await stopped;
});
