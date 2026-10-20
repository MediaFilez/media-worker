import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recoverArtifact, validateArtifact } from "../../src/media-core/download/artifact.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("rejects HTML disguised as an image, including during artifact recovery", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-artifact-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "error.jpg");
    await fs.writeFile(filePath, "<html><body>Access denied</body></html>");
    for (const outputType of ["auto", "image", "thumbnail"]) {
        await assert.rejects(validateArtifact({ filePath, mime: "image/jpeg" }, { outputType }), /signature|recognized/i);
        assert.equal(await recoverArtifact(dir, { outputType }), null);
    }
    const valid = path.join(dir, "real.jpg");
    await fs.writeFile(valid, PNG);
    const recovered = await recoverArtifact(dir, { outputType: "image" });
    assert.equal(recovered.filePath, valid);
    assert.equal(recovered.mime, "image/png");
    assert.equal(recovered.fileName, "real.png");
});
