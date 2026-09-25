import assert from "node:assert/strict";
import test from "node:test";
import { extractPageMetadata } from "../../src/media-core/download/engines/pageMetadata.js";

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
