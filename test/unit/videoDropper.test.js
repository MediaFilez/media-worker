import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadWithVideoDropper } from "../../src/media-core/download/engines/videoDropper.js";
import { downloadMedia, DEFAULT_ENGINES } from "../../src/media-core/download/orchestrator.js";
import { planEngines } from "../../src/media-core/download/planner.js";
import { checkFFmpeg, runFFmpeg } from "../../src/media-core/utils/ffmpeg.js";

const SOURCE = "https://www.instagram.com/reel/Dc4VxwKBGe8";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

async function fixture(t, video = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-videodropper-"));
    let bytes = PNG;
    if (video) {
        const file = path.join(directory, "fixture.mp4");
        await runFFmpeg([
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x64:r=10:d=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.5",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-y",
            file,
        ]);
        bytes = await fs.readFile(file);
    }
    const requests = [];
    const server = http.createServer((request, reply) => {
        requests.push(request.headers);
        reply.writeHead(200, { "content-type": video ? "video/mp4" : "image/png", "content-length": bytes.length });
        reply.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const mediaUrl = `http://127.0.0.1:${server.address().port}/${video ? "video.mp4" : "image.png"}`;
    return { directory, bytes, requests, mediaUrl, options: { trustedHosts: ["127.0.0.1"], maxBytes: 1024 * 1024 } };
}

test("uses the supplied AES protocol and downloads only media without provider headers", async (t) => {
    const f = await fixture(t);
    const result = await downloadWithVideoDropper(` ${SOURCE} `, f.directory, {
        ...f.options,
        outputType: "auto",
        requestVideoDropper: async (headers) => {
            const decipher = createDecipheriv("aes-128-ecb", Buffer.from("qwertyuioplkjhgf"), null);
            assert.equal(decipher.update(headers.url, "hex", "utf8") + decipher.final("utf8"), SOURCE);
            assert.equal(headers.referer, "https://videodropper.app/");
            assert.equal(headers.cookie, undefined);
            assert.equal(headers.authorization, undefined);
            return response({ video: [{ video: f.mediaUrl }] });
        },
    });
    assert.equal(result.method, "videodropper");
    assert.deepEqual(await fs.readFile(result.filePath), f.bytes);
    assert.equal(f.requests[0].url, undefined);
    assert.equal(f.requests[0].referer, "https://www.instagram.com/");
});

test("selects the thumbnail for thumbnail output", async (t) => {
    const f = await fixture(t);
    const result = await downloadWithVideoDropper(SOURCE, f.directory, {
        ...f.options,
        outputType: "thumbnail",
        requestVideoDropper: async () => response({ video: [{ video: "https://unused.invalid/video.mp4", thumbnail: f.mediaUrl }] }),
    });
    assert.equal(result.mediaKind, "image");
});

test("downloads every Instagram carousel item in source order", async (t) => {
    const f = await fixture(t);
    const result = await downloadWithVideoDropper(SOURCE, f.directory, {
        ...f.options,
        outputType: "auto",
        requestVideoDropper: async () => response({ video: [1, 2, 3].map((slide) => ({ image: `${f.mediaUrl}?slide=${slide}` })) }),
    });
    assert.equal(result.items?.length, 3);
    assert.equal(f.requests.length, 3);
    for (const item of result.items) assert.deepEqual(await fs.readFile(item.filePath), f.bytes);
    assert.equal(new Set(result.items.map((item) => item.filePath)).size, 3);
});

test("includes the separate image array alongside videos and avoids duplicate URLs", async (t) => {
    const f = await fixture(t);
    const result = await downloadWithVideoDropper(SOURCE, f.directory, {
        ...f.options,
        outputType: "auto",
        requestVideoDropper: async () =>
            response({ video: [{ video: `${f.mediaUrl}?video` }], image: [`${f.mediaUrl}?one`, `${f.mediaUrl}?two`, `${f.mediaUrl}?one`] }),
    });
    assert.equal(result.items.length, 3);
    assert.equal(f.requests.length, 3);
});

test("supports image-only carousels and preserves the single-image result shape", async (t) => {
    const f = await fixture(t);
    const many = await downloadWithVideoDropper(SOURCE, f.directory, {
        ...f.options,
        outputType: "auto",
        requestVideoDropper: async () => response({ image: [`${f.mediaUrl}?one`, `${f.mediaUrl}?two`] }),
    });
    assert.equal(many.items.length, 2);
    const single = await downloadWithVideoDropper(SOURCE, path.join(f.directory, "single"), {
        ...f.options,
        requestVideoDropper: async () => response({ image: [f.mediaUrl] }),
    });
    assert.equal(single.items, undefined);
});

test("a failed carousel item cannot be recovered as a successful first-item-only post", async (t) => {
    const f = await fixture(t);
    const engines = new Map([
        ["videodropper", downloadWithVideoDropper],
        [
            "single-only",
            async (_url, dir) => {
                await fs.writeFile(path.join(dir, "only.png"), PNG);
                return { filePath: path.join(dir, "only.png"), fileName: "only.png" };
            },
        ],
    ]);
    await assert.rejects(
        downloadMedia(SOURCE, path.join(f.directory, "job"), {
            ...f.options,
            outputType: "auto",
            plan: [...engines.keys()],
            engines,
            requestVideoDropper: async () => response({ image: [f.mediaUrl, "http://127.0.0.1:1/missing.png"] }),
        }),
    );
});

test("enforces the total byte limit across carousel files", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
        downloadWithVideoDropper(SOURCE, f.directory, {
            ...f.options,
            maxBytes: PNG.length + 1,
            requestVideoDropper: async () => response({ image: [`${f.mediaUrl}?one`, `${f.mediaUrl}?two`] }),
        }),
        (error) => error.code === "FILE_TOO_LARGE" && error.stopFallback,
    );
});

test("does not send other platforms or credential-bearing URLs to VideoDropper", async () => {
    for (const url of [
        "https://example.com/reel/1",
        "https://instagram.com.evil.example/reel/1",
        "https://user:secret@instagram.com/reel/1",
        "ftp://instagram.com/reel/1",
    ]) {
        await assert.rejects(
            downloadWithVideoDropper(url, "unused", { requestVideoDropper: () => assert.fail("must not request") }),
            /only accepts Instagram/,
        );
    }
});

test("rejects provider redirects, errors, malformed JSON, empty media and oversized responses", async () => {
    const cases = [
        () => response({}, 302),
        () => response({}, 503),
        () => new Response("<html>not JSON</html>"),
        () => response({ video: [] }),
        () => new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } }),
        () => new Response('"' + "x".repeat(1024 * 1024) + '"'),
    ];
    for (const requestVideoDropper of cases) {
        await assert.rejects(downloadWithVideoDropper(SOURCE, "unused", { requestVideoDropper }), { name: "DownloadMethodError" });
    }
});

test("keeps private media URLs blocked", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-private-media-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await assert.rejects(
        downloadWithVideoDropper(SOURCE, directory, {
            requestVideoDropper: async () => response({ video: [{ video: "http://127.0.0.1/private.mp4" }] }),
        }),
        (error) => error.stopFallback && error.code === "PRIVATE_URL",
    );
});

test("keeps download byte limits active", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
        downloadWithVideoDropper(SOURCE, f.directory, {
            ...f.options,
            maxBytes: 10,
            requestVideoDropper: async () => response({ video: [{ video: f.mediaUrl }] }),
        }),
        (error) => error.stopFallback && error.code === "FILE_TOO_LARGE",
    );
});

function pendingResponse(_headers, signal) {
    return new Promise((_resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
}

test("bounds a stalled resolver and preserves parent cancellation", async () => {
    // Keep the process alive while AbortSignal.timeout's unref'ed timer runs.
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(
            downloadWithVideoDropper(SOURCE, "unused", { videoDropperTimeoutMs: 30, requestVideoDropper: pendingResponse }),
            /timed out/,
        );
        const controller = new AbortController();
        const reason = new Error("cancelled by test");
        const promise = downloadWithVideoDropper(SOURCE, "unused", { signal: controller.signal, requestVideoDropper: pendingResponse });
        controller.abort(reason);
        await assert.rejects(promise, (error) => error === reason);
    } finally {
        clearTimeout(keepAlive);
    }
});

test("tries VideoDropper first for each Instagram output and allows disabling it", () => {
    for (const type of ["auto", "video", "image", "audio", "thumbnail"]) {
        assert.equal(planEngines(SOURCE, type)[0], "videodropper");
    }
    assert.ok(!planEngines(SOURCE, "video", { disabledEngines: new Set(["videodropper"]), cobaltApiEndpoints: [] }).includes("videodropper"));
});

test("commits an audible VideoDropper artifact without trying another engine", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const f = await fixture(t, true);
    const jobDir = path.join(f.directory, "job");
    const engines = [];
    const result = await downloadMedia(SOURCE, jobDir, {
        ...f.options,
        outputType: "video",
        requestVideoDropper: async () => response({ video: [{ video: f.mediaUrl }] }),
        onStatus: (update) => {
            if (update.phase === "resolving") engines.push(update.engine);
        },
    });
    assert.deepEqual(engines, ["videodropper"]);
    assert.equal(result.method, "videodropper");
    assert.equal(result.mediaInfo.hasAudio, true);
    assert.deepEqual(await fs.readFile(result.filePath), f.bytes);
});

test("a VideoDropper failure reaches the existing next engine", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const f = await fixture(t, true);
    const engines = new Map(DEFAULT_ENGINES);
    const fallback = planEngines(SOURCE, "video")[1];
    engines.set(fallback, async (_source, dir) => {
        const filePath = path.join(dir, "fallback.mp4");
        await fs.writeFile(filePath, f.bytes);
        return { filePath, fileName: "fallback.mp4", method: fallback };
    });
    const result = await downloadMedia(SOURCE, path.join(f.directory, "job"), {
        ...f.options,
        outputType: "video",
        engines,
        requestVideoDropper: async () => response({}, 503),
    });
    assert.equal(result.attempts[0].engine, "videodropper");
    assert.equal(result.method, fallback);
});
