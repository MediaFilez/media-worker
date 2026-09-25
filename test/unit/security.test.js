import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedAddress, parsePublicHttpUrl } from "../../src/media-core/utils/security.js";

test("blocks private and reserved IP addresses", () => {
    for (const address of ["127.0.0.1", "10.2.3.4", "169.254.1.1", "192.168.1.1", "::1", "fd00::1"]) {
        assert.equal(isBlockedAddress(address), true, address);
    }
    assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("accepts only HTTP URLs", () => {
    assert.equal(parsePublicHttpUrl("https://example.com/x").hostname, "example.com");
    assert.throws(() => parsePublicHttpUrl("file:///etc/passwd"), /Only http/);
});
