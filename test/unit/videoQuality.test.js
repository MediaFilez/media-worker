import assert from "node:assert/strict";
import test from "node:test";
import { MB } from "../../src/media-core/config.js";
import { preferredVideoHeight, ytDlpFormatSelector } from "../../src/media-core/download/videoQuality.js";

test("selects a smaller source when a target byte budget is supplied", () => {
    assert.equal(preferredVideoHeight(10 * MB), 360);
    assert.equal(preferredVideoHeight(25 * MB), 480);
    assert.equal(preferredVideoHeight(75 * MB), 720);
    assert.equal(preferredVideoHeight(200 * MB), null);
});

test("yt-dlp prefers the requested height without restricting codecs", () => {
    const selector = ytDlpFormatSelector("video", 10 * MB);
    assert.equal(selector, "bv*[height<=360]+ba/b[height<=360]/bv*+ba/b");
});

test("audio and large uploads keep their existing best-quality selectors", () => {
    assert.equal(ytDlpFormatSelector("audio", 10 * MB), "ba/b");
    assert.equal(ytDlpFormatSelector("video", 200 * MB), "bv*+ba/b");
    assert.equal(ytDlpFormatSelector("video"), "bv*+ba/b");
});
