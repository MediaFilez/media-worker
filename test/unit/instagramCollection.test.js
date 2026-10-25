import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadWithYtDlp } from "../../src/media-core/download/engines/ytDlp.js";
import { downloadWithGalleryDl } from "../../src/media-core/download/engines/galleryDl.js";
import { downloadMedia } from "../../src/media-core/download/orchestrator.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const SOURCE = "https://www.instagram.com/p/fixture/";

for (const [name, download] of [
    ["yt-dlp", downloadWithYtDlp],
    ["gallery-dl", downloadWithGalleryDl],
]) {
    test(`${name} cannot hide an invalid slide by recovering only the valid one`, async (t) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-invalid-album-"));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        await assert.rejects(
            downloadMedia(SOURCE, directory, {
                outputType: "auto",
                maxBytes: 1024 * 1024,
                plan: [name, "single-only"],
                engines: new Map([
                    [name, download],
                    [
                        "single-only",
                        async (_url, dir) => {
                            const filePath = path.join(dir, "only.png");
                            await fs.writeFile(filePath, PNG);
                            return { filePath, fileName: "only.png" };
                        },
                    ],
                ]),
                processRunner: async (_command, args) => {
                    const dir = args[args.indexOf(name === "yt-dlp" ? "--output" : "--directory") + 1];
                    const attempt = name === "yt-dlp" ? path.dirname(dir) : dir;
                    await fs.writeFile(path.join(attempt, "1.png"), PNG);
                    await fs.writeFile(path.join(attempt, "2.png"), "<html>not an image</html>");
                },
            }),
        );
    });
    test(`${name} recovers the full Instagram collection in numeric order`, async (t) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-album-"));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const result = await download(SOURCE, directory, {
            outputType: "auto",
            maxBytes: 1024 * 1024,
            processRunner: async (_command, args) => {
                if (name === "yt-dlp") {
                    assert.ok(args.includes("--yes-playlist"));
                    assert.equal(args.includes("--max-downloads"), false);
                    assert.equal(args[args.indexOf("--playlist-end") + 1], "51");
                } else {
                    assert.equal(args[args.indexOf("--range") + 1], "1-51");
                }
                for (const index of [10, 2, 1]) await fs.writeFile(path.join(directory, `${index}.png`), PNG);
            },
        });
        assert.equal(result.items.length, 3);
        assert.deepEqual(
            result.items.map((item) => path.basename(item.filePath)),
            ["1.png", "2.png", "10.png"],
        );
    });

    test(`${name} does not recover the first slide after an Instagram tool failure`, async (t) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-partial-album-"));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        await assert.rejects(
            download(SOURCE, directory, {
                outputType: "auto",
                maxBytes: 1024 * 1024,
                processRunner: async () => {
                    await fs.writeFile(path.join(directory, "1.png"), PNG);
                    throw new Error("the next slide failed");
                },
            }),
            (error) => error.incompleteCollection === true,
        );
    });
}
