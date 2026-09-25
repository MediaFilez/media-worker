import assert from "node:assert/strict";
import test from "node:test";
import { planEngines } from "../../src/media-core/download/planner.js";

const settings = {
    disabledEngines: new Set(),
    youtubeJsEnabled: true,
    galleryDlEnabled: true,
    pageMetadataEnabled: true,
    instagramProxyHosts: ["www.kkkinstagram.com"],
    redditProxyHosts: ["redditez.com"],
    cobaltApiEndpoints: ["http://cobalt:9000"],
    cobaltDirectoryEnabled: false,
};

test("plans ordered YouTube fallbacks", () => {
    assert.deepEqual(planEngines("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "video", settings), [
        "yt-dlp",
        "youtube-js",
        "cobalt",
        "page-metadata",
    ]);
});

test("sends social image posts to gallery-dl first", () => {
    assert.deepEqual(planEngines("https://www.instagram.com/p/example/", "image", settings), [
        "gallery-dl",
        "yt-dlp",
        "instagram-proxy",
        "cobalt",
        "page-metadata",
    ]);
});

test("uses the Instagram redirect fallback before general extractors", () => {
    assert.deepEqual(planEngines("https://www.instagram.com/reels/example/", "video", settings), [
        "yt-dlp",
        "instagram-proxy",
        "cobalt",
        "gallery-dl",
        "page-metadata",
    ]);
});

test("lets an operator prefer the configured Instagram proxy for video and auto output", () => {
    const preferred = { ...settings, instagramProxyFirst: true };
    const expected = ["instagram-proxy", "yt-dlp", "cobalt", "gallery-dl", "page-metadata"];

    assert.deepEqual(planEngines("https://www.instagram.com/reel/example/", "video", preferred), expected);
    assert.deepEqual(planEngines("https://www.instagram.com/reel/example/", "auto", preferred), expected);
});

test("sends Pinterest to gallery-dl for video and image posts", () => {
    assert.deepEqual(planEngines("https://www.pinterest.com/pin/example/", "video", settings), ["gallery-dl", "yt-dlp", "cobalt", "page-metadata"]);
});

test("routes official Cobalt services through Cobalt before generic extractors", () => {
    const urls = [
        "https://www.bilibili.com/video/example",
        "https://www.dailymotion.com/video/example",
        "https://www.loom.com/share/example",
        "https://www.newgrounds.com/portal/view/example",
        "https://ok.ru/video/example",
        "https://rutube.ru/video/example",
        "https://clips.twitch.tv/example",
    ];

    for (const url of urls) {
        assert.deepEqual(planEngines(url, "auto", settings), ["cobalt", "yt-dlp", "gallery-dl", "page-metadata"]);
    }
});

test("routes TikTok short links through media extractors", () => {
    const urls = [
        "https://vt.tiktok.com/ZSqVMCEkT",
        "https://vt.tiktok.com/ZSqVh1mdo/",
        "https://vt.tiktok.com/ZSqVhe8cD/",
        "https://vm.tiktok.com/example/",
    ];

    for (const url of urls) {
        assert.deepEqual(planEngines(url, "video", settings), ["cobalt", "yt-dlp", "gallery-dl", "page-metadata"]);
    }
});

test("routes official platform subdomains through media extractors", () => {
    const cases = [
        ["https://in.pinterest.com/pin/591590101088175088/", ["gallery-dl", "yt-dlp", "cobalt", "page-metadata"]],
        ["https://m.bilibili.com/video/BV1xx411c7mD", ["cobalt", "yt-dlp", "gallery-dl", "page-metadata"]],
        ["https://player.vimeo.com/video/76979871", ["cobalt", "yt-dlp", "gallery-dl", "page-metadata"]],
        ["https://m.facebook.com/watch/?v=10153231379946729", ["cobalt", "yt-dlp", "gallery-dl", "page-metadata"]],
        ["https://v.redd.it/example", ["cobalt", "yt-dlp", "reddit-embed", "reddit-proxy", "gallery-dl", "page-metadata"]],
    ];

    for (const [url, expected] of cases) {
        assert.deepEqual(planEngines(url, "video", settings), expected);
    }
});

test("uses Reddit embed fallback for short image links", () => {
    assert.deepEqual(planEngines("https://www.reddit.com/r/discordapp/s/example", "image", settings), [
        "reddit-embed",
        "reddit-proxy",
        "gallery-dl",
        "yt-dlp",
        "cobalt",
        "page-metadata",
    ]);
});

test("lets auto detection use media-aware social extractors first", () => {
    assert.deepEqual(planEngines("https://www.instagram.com/p/example/", "auto", settings), [
        "gallery-dl",
        "yt-dlp",
        "instagram-proxy",
        "cobalt",
        "page-metadata",
    ]);
    assert.deepEqual(planEngines("https://www.reddit.com/r/discordapp/s/example", "auto", settings), [
        "reddit-embed",
        "reddit-proxy",
        "gallery-dl",
        "yt-dlp",
        "cobalt",
        "page-metadata",
    ]);
    assert.deepEqual(planEngines("https://cdn.example.com/file.mp3", "auto", settings), ["direct-http"]);
});

test("keeps unrecognized hosts inside guarded HTTP engines", () => {
    assert.deepEqual(planEngines("https://example.com/post", "auto", settings), ["page-metadata", "direct-http"]);
    assert.deepEqual(planEngines("https://tiktok.com.evil.example/post", "auto", settings), ["page-metadata", "direct-http"]);
    assert.deepEqual(planEngines("https://cdn.example.com/video.mp4", "video", settings), ["direct-http"]);
});

test("filters disabled and unconfigured engines", () => {
    const minimal = {
        ...settings,
        disabledEngines: new Set(["youtube-js"]),
        cobaltApiEndpoints: [],
        pageMetadataEnabled: false,
    };
    assert.deepEqual(planEngines("https://youtu.be/dQw4w9WgXcQ", "video", minimal), ["yt-dlp"]);

    assert.deepEqual(
        planEngines("https://m.reddit.com/r/discordapp/s/example", "auto", {
            ...settings,
            redditProxyHosts: [],
        }),
        ["reddit-embed", "gallery-dl", "yt-dlp", "cobalt", "page-metadata"],
    );
});
