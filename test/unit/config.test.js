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

test("keeps YouTube.js disabled until an evaluator is configured", async () => {
    const configUrl = new URL("../../src/media-core/config.js", import.meta.url).href;
    const script = `import { config } from ${JSON.stringify(configUrl)}; process.stdout.write(String(config.youtubeJsEnabled));`;
    const env = { ...process.env };
    delete env.YOUTUBE_JS_ENABLED;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: os.tmpdir(),
        env,
    });

    assert.equal(stdout, "false");
});

test("uses fast, bounded fallback defaults", async () => {
    const configUrl = new URL("../../src/media-core/config.js", import.meta.url).href;
    const script = `import { config } from ${JSON.stringify(configUrl)}; process.stdout.write(JSON.stringify({ yt: config.ytdlpRetries, ytTimeout: config.ytdlpSocketTimeoutSeconds, gallery: config.galleryDlRetries, galleryTimeout: config.galleryDlHttpTimeoutSeconds, galleryProcessTimeout: config.galleryDlTimeoutMs }));`;
    const env = { ...process.env };
    delete env.YTDLP_RETRIES;
    delete env.YTDLP_SOCKET_TIMEOUT_SECONDS;
    delete env.GALLERY_DL_RETRIES;
    delete env.GALLERY_DL_HTTP_TIMEOUT_SECONDS;
    delete env.GALLERY_DL_TIMEOUT_MS;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: os.tmpdir(),
        env,
    });

    assert.deepEqual(JSON.parse(stdout), { yt: 1, ytTimeout: 15, gallery: 1, galleryTimeout: 15, galleryProcessTimeout: 30_000 });
});

test("Grabfy requires explicit opt-in and bounds its resolver timeout", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { tmpdir } = await import("node:os");
    const run = promisify(execFile);
    const configUrl = new URL("../../src/media-core/config.js", import.meta.url).href;
    const script = `import { config } from ${JSON.stringify(configUrl)}; process.stdout.write(JSON.stringify([config.grabfyEnabled, config.grabfyTimeoutMs]));`;

    for (const [enabled, timeout, expected] of [
        ["", "", [false, 20000]],
        ["true", "1", [true, 1000]],
        ["false", "999999", [false, 60000]],
    ]) {
        const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", script], {
            cwd: tmpdir(),
            env: { ...process.env, GRABFY_ENABLED: enabled, GRABFY_TIMEOUT_MS: timeout },
        });
        assert.deepEqual(JSON.parse(stdout), expected);
    }
});
