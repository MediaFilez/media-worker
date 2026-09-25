import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities } from "../../src/media-core/utils/htmlEntities.js";

test("decodes named, decimal, and hexadecimal HTML entities", () => {
    assert.equal(decodeHtmlEntities("&amp;&quot;&#39;&apos;&lt;&gt;&#47;&#x2f;"), `&"''<>//`);
});

test("does not decode replacement text a second time", () => {
    assert.equal(decodeHtmlEntities("&amp;quot;&amp;#39;&amp;#x2f;"), "&quot;&#39;&#x2f;");
});

test("preserves invalid numeric entities", () => {
    assert.equal(decodeHtmlEntities("&#1114112;"), "&#1114112;");
});
