import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../../src/media-core/utils/process.js";

test("caps an unterminated child-process output line", async () => {
    let deliveredLine = "";
    const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"], {
        onStdoutLine: (line) => {
            deliveredLine = line;
        },
    });

    assert.ok(Buffer.byteLength(result.stdout) <= 4 * 1024 * 1024);
    assert.ok(Buffer.byteLength(deliveredLine) <= 4 * 1024 * 1024);
});
