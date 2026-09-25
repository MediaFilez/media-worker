import assert from "node:assert/strict";
import test from "node:test";
import { MB } from "../../src/media-core/config.js";
import { preferredVideoHeight, ytDlpFormatSelector } from "../../src/media-core/download/videoQuality.js";

test("caps source resolution for small Discord upload targets", () => {
    assert.equal(preferredVideoHeight(10 * MB), 360);
    assert.equal(preferredVideoHeight(25 * MB), 480);
    assert.equal(preferredVideoHeight(75 * MB), 720);
    assert.equal(preferredVideoHeight(200 * MB), null);
});

test("yt-dlp prefers a capped AVC source before falling back to best quality", () => {
    const selector = ytDlpFormatSelector("video", 10 * MB);
    assert.match(selector, /^bv\[height<=360\]\[vcodec\^=avc1\]\+ba\[ext=m4a\]\//);
    assert.match(selector, /bv\*\[vcodec\^=avc1\]\+ba\[ext=m4a\]/);
});

test("audio and large uploads keep their existing best-quality selectors", () => {
    assert.equal(ytDlpFormatSelector("audio", 10 * MB), "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio");
    assert.equal(ytDlpFormatSelector("video", 200 * MB), "bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b");
});
