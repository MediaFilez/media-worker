import assert from "node:assert/strict";
import test from "node:test";
import { extractRedditPostMedia } from "../../src/media-core/download/engines/redditEmbed.js";

test("extracts the post media URL from Reddit embed context", () => {
    const html = `
        <shreddit-screenview-data
            data="{&quot;post&quot;:{&quot;id&quot;:&quot;t3_1vo14ig&quot;,&quot;url&quot;:&quot;https://i.redd.it/6q518hjjrajh1.png&quot;,&quot;type&quot;:&quot;image&quot;}}">
        </shreddit-screenview-data>
    `;

    assert.deepEqual(extractRedditPostMedia(html), {
        candidates: ["https://i.redd.it/6q518hjjrajh1.png"],
        mediaKind: "image",
    });
});

test("ignores unrelated Reddit page images", () => {
    const html = `
        <img src="https://styles.redditmedia.com/community-icon.jpg">
        <img src="https://www.redditstatic.com/logo.png">
    `;

    assert.deepEqual(extractRedditPostMedia(html), { candidates: [], mediaKind: null });
});
