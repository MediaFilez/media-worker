import assert from "node:assert/strict";
import test from "node:test";
import { galleryDlArgs } from "../../src/media-core/download/engines/galleryDl.js";

test("caps gallery-dl before transfer and terminates option parsing", () => {
    const rawUrl = "https://example.com/-dangerous";
    const args = galleryDlArgs(rawUrl, "attempt", { maxBytes: 12_345 });
    const separator = args.indexOf("--");

    assert.deepEqual(args.slice(args.indexOf("--filesize-max"), args.indexOf("--filesize-max") + 2), ["--filesize-max", "12345"]);
    assert.ok(args.indexOf("--filesize-max") < separator);
    assert.equal(args.at(separator + 1), rawUrl);
    assert.equal(separator, args.length - 2);
});
