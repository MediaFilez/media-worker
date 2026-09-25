import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../../src/media-core/config.js";
import { downloadWithYtDlp } from "../../src/media-core/download/engines/ytDlp.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("gives yt-dlp a private writable cookie copy", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-ytdlp-"));
    const attemptDir = path.join(root, "attempt");
    const originalCookies = path.join(root, "cookies.txt");
    const cookieContents = "# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tsession\tsecret\n";
    await fs.mkdir(attemptDir);
    await fs.writeFile(originalCookies, cookieContents, { mode: 0o400 });
    t.after(async () => {
        config.mediaCookiesFile = null;
        await fs.chmod(originalCookies, 0o600).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    });

    config.mediaCookiesFile = originalCookies;
    let cookieArgument;
    const result = await downloadWithYtDlp("https://example.com/media", attemptDir, {
        outputType: "image",
        maxBytes: 1024 * 1024,
        processRunner: async (_executable, args) => {
            cookieArgument = args[args.indexOf("--cookies") + 1];
            assert.notEqual(cookieArgument, originalCookies);
            await fs.appendFile(cookieArgument, "# yt-dlp update\n");
            await fs.writeFile(path.join(attemptDir, "result.png"), PNG);
        },
    });

    assert.equal(result.method, "yt-dlp");
    assert.equal(path.dirname(cookieArgument), attemptDir);
    assert.equal(await fs.readFile(originalCookies, "utf8"), cookieContents);
    if (process.platform !== "win32") {
        assert.equal((await fs.stat(cookieArgument)).mode & 0o777, 0o600);
    }
});

test("uses anonymous yt-dlp requests for ordinary YouTube links by default", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-ytdlp-"));
    const attemptDir = path.join(root, "attempt");
    const originalCookies = path.join(root, "cookies.txt");
    await fs.mkdir(attemptDir);
    await fs.writeFile(originalCookies, "# Netscape HTTP Cookie File\n", { mode: 0o400 });
    t.after(async () => {
        config.mediaCookiesFile = null;
        config.ytdlpCookiesForYoutube = false;
        await fs.chmod(originalCookies, 0o600).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    });

    config.mediaCookiesFile = originalCookies;
    config.ytdlpCookiesForYoutube = false;
    await downloadWithYtDlp("https://youtu.be/example", attemptDir, {
        outputType: "image",
        maxBytes: 1024 * 1024,
        processRunner: async (_executable, args) => {
            assert.equal(args.includes("--cookies"), false);
            await fs.writeFile(path.join(attemptDir, "result.png"), PNG);
        },
    });
});

test("allows cookies for YouTube when the operator opts in", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-ytdlp-"));
    const attemptDir = path.join(root, "attempt");
    const originalCookies = path.join(root, "cookies.txt");
    await fs.mkdir(attemptDir);
    await fs.writeFile(originalCookies, "# Netscape HTTP Cookie File\n", { mode: 0o400 });
    t.after(async () => {
        config.mediaCookiesFile = null;
        config.ytdlpCookiesForYoutube = false;
        await fs.chmod(originalCookies, 0o600).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    });

    config.mediaCookiesFile = originalCookies;
    config.ytdlpCookiesForYoutube = true;
    await downloadWithYtDlp("https://www.youtube.com/watch?v=example", attemptDir, {
        outputType: "image",
        maxBytes: 1024 * 1024,
        processRunner: async (_executable, args) => {
            assert.notEqual(args.indexOf("--cookies"), -1);
            await fs.writeFile(path.join(attemptDir, "result.png"), PNG);
        },
    });
});
