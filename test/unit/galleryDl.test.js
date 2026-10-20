import assert from "node:assert/strict";
import test from "node:test";
import { galleryDlArgs, downloadWithGalleryDl } from "../../src/media-core/download/engines/galleryDl.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../../src/media-core/config.js";

test("gallery-dl receives a private writable cookie copy instead of the shared mount", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-gallery-cookies-"));
    const source = path.join(dir, "cookies.txt");
    const attempt = path.join(dir, "attempt");
    const previous = config.mediaCookiesFile;
    await fs.mkdir(attempt);
    await fs.writeFile(source, "# Netscape HTTP Cookie File\n");
    config.mediaCookiesFile = source;
    t.after(async () => {
        config.mediaCookiesFile = previous;
        await fs.rm(dir, { recursive: true, force: true });
    });
    await downloadWithGalleryDl("https://example.com/image", attempt, {
        outputType: "image",
        processRunner: async (_command, args) => {
            const copied = args[args.indexOf("--cookies") + 1];
            assert.notEqual(copied, source);
            await fs.appendFile(copied, "# tool update\n");
            await fs.writeFile(
                path.join(attempt, "result.png"),
                Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
            );
        },
    });
    assert.equal(await fs.readFile(source, "utf8"), "# Netscape HTTP Cookie File\n");
});

test("caps gallery-dl before transfer and terminates option parsing", () => {
    const rawUrl = "https://example.com/-dangerous";
    const args = galleryDlArgs(rawUrl, "attempt", { maxBytes: 12_345 });
    const separator = args.indexOf("--");

    assert.deepEqual(args.slice(args.indexOf("--filesize-max"), args.indexOf("--filesize-max") + 2), ["--filesize-max", "12345"]);
    assert.deepEqual(args.slice(args.indexOf("--sleep-retries"), args.indexOf("--sleep-retries") + 2), ["--sleep-retries", "0"]);
    assert.ok(args.indexOf("--filesize-max") < separator);
    assert.equal(args.at(separator + 1), rawUrl);
    assert.equal(separator, args.length - 2);
    assert.ok(args.includes("--ignore-config"));
    assert.ok(args.includes("extractor.proxy-env=false"));
});

test("gallery-dl forwards the quality preference to nested yt-dlp", () => {
    const args = galleryDlArgs("https://example.com/", "attempt", { maxHeight: 720, outputType: "video" });
    assert.ok(args.some((arg) => arg.startsWith("extractor.ytdl.format=") && arg.includes("height<=720")));
    assert.ok(args.some((arg) => arg.startsWith("downloader.ytdl.format=") && arg.includes("height<=720")));
});
