import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("does not force an unavailable yt-dlp impersonation target", async () => {
    const configUrl = new URL("../../src/media-core/config.js", import.meta.url).href;
    const script = `import { config } from ${JSON.stringify(configUrl)}; process.stdout.write(String(config.ytdlpImpersonate));`;
    const env = { ...process.env, YTDLP_IMPERSONATE: "" };
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: os.tmpdir(),
        env,
    });

    assert.equal(stdout, "null");
});
