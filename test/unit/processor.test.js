import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { processMedia } from "../../src/media-core/media/processor.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const cases = [
    { mediaKind: "video", extension: "mp4", contents: Buffer.from("video") },
    { mediaKind: "audio", extension: "mp3", contents: Buffer.from("ID3audio") },
    { mediaKind: "image", extension: "png", contents: PNG },
];

for (const fixture of cases) {
    test(`auto prepares detected ${fixture.mediaKind} media`, async (t) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-auto-"));
        t.after(() => fs.rm(dir, { recursive: true, force: true }));
        const fileName = `source.${fixture.extension}`;
        const filePath = path.join(dir, fileName);
        await fs.writeFile(filePath, fixture.contents);

        const output = await processMedia(
            {
                filePath,
                fileName,
                sizeBytes: fixture.contents.length,
                mediaKind: fixture.mediaKind,
                extension: fixture.extension,
                isAudioOnly: fixture.mediaKind === "audio",
            },
            {
                outputType: "auto",
                tempDir: dir,
                maxOutputBytes: 1024,
                allowCompression: true,
            },
        );

        assert.equal(output.mediaKind, fixture.mediaKind);
        assert.ok(output.sizeBytes > 0);
    });
}

test("auto applies video size rules to detected video", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-auto-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "large.mp4");
    await fs.writeFile(filePath, Buffer.alloc(32));

    await assert.rejects(
        processMedia(
            {
                filePath,
                fileName: "large.mp4",
                sizeBytes: 32,
                mediaKind: "video",
                extension: "mp4",
            },
            {
                outputType: "auto",
                tempDir: dir,
                maxOutputBytes: 16,
                allowCompression: false,
            },
        ),
        (error) => error.code === "FILE_TOO_LARGE" && /The video is/.test(error.message),
    );
});
