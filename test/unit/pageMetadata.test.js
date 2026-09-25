import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadFromPageMetadata, extractPageMetadata } from "../../src/media-core/download/engines/pageMetadata.js";

async function listen(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
}

test("extracts ordered Open Graph media and resolves relative URLs", () => {
    const html = `
        <meta property="og:title" content="Example reel">
        <meta property="og:video:secure_url" content="/media/reel.mp4?x=1&amp;y=2">
        <meta property="og:video" content="https://cdn.example.net/fallback.mp4">
    `;
    const metadata = extractPageMetadata(html, new URL("https://example.com/post/1"), "video");

    assert.equal(metadata.title, "Example reel");
    assert.deepEqual(metadata.candidates, ["https://example.com/media/reel.mp4?x=1&y=2", "https://cdn.example.net/fallback.mp4"]);
});

test("keeps image metadata separate from video candidates", () => {
    const html = `
        <meta property="og:video" content="https://cdn.example/video.mp4">
        <meta property="og:image" content="https://cdn.example/post.jpg">
    `;
    const metadata = extractPageMetadata(html, new URL("https://example.com/post"), "image");
    assert.deepEqual(metadata.candidates, ["https://cdn.example/post.jpg"]);
});

test("unwraps encoded media URLs from share-link query parameters", () => {
    const baseUrl = new URL("https://www.reddit.com/media?url=https%3A%2F%2Fi.redd.it%2F6q518hjjrajh1.png");
    const metadata = extractPageMetadata("<html></html>", baseUrl, "image");

    assert.deepEqual(metadata.candidates, ["https://i.redd.it/6q518hjjrajh1.png"]);
});

test("extracts media content URLs from JSON-LD", () => {
    const html = `
        <script type="application/ld+json">
            {
                "@type": "VideoObject",
                "name": "Example clip",
                "contentUrl": "https://cdn.example.net/assets/clip.mp4"
            }
        </script>
    `;
    const metadata = extractPageMetadata(html, new URL("https://small.example/post/1"), "video");

    assert.deepEqual(metadata.candidates, ["https://cdn.example.net/assets/clip.mp4"]);
});

test("auto metadata tries video, audio, then image candidates", () => {
    const html = `
        <meta property="og:image" content="https://cdn.example/post.jpg">
        <meta property="og:audio" content="https://cdn.example/track.mp3">
        <meta property="og:video" content="https://cdn.example/clip.mp4">
    `;
    const metadata = extractPageMetadata(html, new URL("https://example.com/post"), "auto");

    assert.deepEqual(metadata.candidates, ["https://cdn.example/clip.mp4", "https://cdn.example/track.mp3", "https://cdn.example/post.jpg"]);
});

test("decodes each HTML entity exactly once", () => {
    const html = `
        <meta property="og:title" content="A &amp;quot;nested&amp;quot; title">
        <meta property="og:image" content="https://cdn.example/post.jpg">
    `;
    const metadata = extractPageMetadata(html, new URL("https://example.com/post"), "image");

    assert.equal(metadata.title, "A &quot;nested&quot; title");
});

test("uses the shorter page probe timeout before falling back", async (t) => {
    const server = await listen((_request, response) => {
        setTimeout(() => response.end("<html></html>"), 300).unref();
    });
    const address = server.address();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-page-timeout-"));
    t.after(async () => {
        await fs.rm(directory, { recursive: true, force: true });
        await new Promise((resolve) => server.close(resolve));
    });

    const startedAt = performance.now();
    await assert.rejects(
        downloadFromPageMetadata(`http://127.0.0.1:${address.port}/slow`, directory, {
            outputType: "auto",
            pageMetadataTimeoutMs: 50,
            trustedHosts: ["127.0.0.1"],
        }),
    );
    assert.ok(performance.now() - startedAt < 250, "a blocked page probe must fail fast");
});
