import assert from "node:assert/strict";
import test from "node:test";
import { DownloadMethodError } from "../../src/media-core/utils/errors.js";
import { downloadWithRedditProxy, redditProxyUrl } from "../../src/media-core/download/engines/redditProxy.js";

const SHARE_URL = "https://www.reddit.com/r/discordapp/s/TnQxbuphId";

test("preserves Reddit share paths when building a proxy URL", () => {
    assert.equal(redditProxyUrl(SHARE_URL, "redditez.com").href, "https://redditez.com/r/discordapp/s/TnQxbuphId");
});

test("rejects non-Reddit sources", () => {
    assert.throws(() => redditProxyUrl("https://example.com/post", "redditez.com"), /only accepts Reddit URLs/);
});

test("continues to the next Reddit proxy after a blocked response", async () => {
    const calls = [];
    const result = await downloadWithRedditProxy(SHARE_URL, "unused", {
        proxyHosts: ["blocked.example", "working.example"],
        pageDownloader: async (url) => {
            calls.push(url);
            if (url.includes("blocked.example")) {
                throw new DownloadMethodError("page-metadata", "HTTP 403");
            }
            return {
                filePath: "result.png",
                fileName: "result.png",
                mediaKind: "image",
                metadata: { extractor: "Open Graph" },
            };
        },
    });

    assert.deepEqual(calls, ["https://blocked.example/r/discordapp/s/TnQxbuphId", "https://working.example/r/discordapp/s/TnQxbuphId"]);
    assert.equal(result.method, "reddit-proxy:working.example");
    assert.equal(result.metadata.sourceUrl, SHARE_URL);
});
