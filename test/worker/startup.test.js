import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCookieFile } from "../../src/startup.ts";

test("cookie startup validation rejects a directory mount, missing file and malformed file", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-startup-"));
    t.after(() => fs.rm(dir, { force: true, recursive: true }));
    await assert.rejects(validateCookieFile(dir), /Netscape cookie file/);
    await assert.rejects(validateCookieFile(path.join(dir, "missing")), /ENOENT/);
    const file = path.join(dir, "cookies.txt");
    await fs.writeFile(file, "not a cookie file");
    await assert.rejects(validateCookieFile(file), /header/);
    await fs.writeFile(file, "# Netscape HTTP Cookie File\n");
    await assert.doesNotReject(validateCookieFile(file));
    await assert.doesNotReject(validateCookieFile(null));
});
