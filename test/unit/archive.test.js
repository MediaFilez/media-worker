import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArchive } from "../../src/media-core/archive.ts";

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-archive-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, "source");
    await fs.writeFile(filePath, "media");
    return { dir, file: { filePath, fileName: "clip.mp4", sizeBytes: 5 }, output: path.join(dir, "media.zip") };
}

function entryNames(zip) {
    const names = [];
    let offset = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (offset >= 0 && zip.readUInt32LE(offset) === 0x02014b50) {
        const nameLength = zip.readUInt16LE(offset + 28);
        names.push(zip.toString("utf8", offset + 46, offset + 46 + nameLength));
        offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    return names;
}

test("fails and removes the ZIP when an input disappears", async (t) => {
    const { dir, file, output } = await fixture(t);
    await assert.rejects(createArchive([file, { ...file, filePath: path.join(dir, "missing"), fileName: "missing.mp4" }], output), /ENOENT/);
    await assert.rejects(fs.access(output), { code: "ENOENT" });
});

test("limits ZIP bytes during streaming and removes partial output", async (t) => {
    const { file, output } = await fixture(t);
    await assert.rejects(createArchive([file], output, { maxBytes: 10 }), (error) => error.code === "BATCH_TOO_LARGE");
    await assert.rejects(fs.access(output), { code: "ENOENT" });
});

test("keeps every duplicate name distinct and strips archive traversal", async (t) => {
    const { file, output } = await fixture(t);
    const result = await createArchive([file, file, { ...file, fileName: "../clip.mp4" }, { ...file, fileName: "..\\clip.mp4" }], output);
    const names = entryNames(await fs.readFile(result.filePath));
    assert.equal(names.length, 4);
    assert.equal(new Set(names).size, 4);
    assert.ok(names.every((name) => !name.includes("/") && !name.includes("\\") && name.endsWith("clip.mp4")));
});

test("cancels ZIP creation and removes its partial file", async (t) => {
    const { file, output } = await fixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createArchive([file], output, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(fs.access(output), { code: "ENOENT" });
});

test("does not overwrite or remove an existing archive destination", async (t) => {
    const { file, output } = await fixture(t);
    await fs.writeFile(output, "existing archive");
    await assert.rejects(createArchive([file], output), { code: "EEXIST" });
    assert.equal(await fs.readFile(output, "utf8"), "existing archive");
});

test("settles cancellation after opening the ZIP and releases the output handle", async (t) => {
    const { file, output } = await fixture(t);
    const controller = new AbortController();
    const createWriteStream = nodeFs.createWriteStream;
    t.mock.method(nodeFs, "createWriteStream", (...args) => {
        const stream = createWriteStream(...args);
        stream.once("open", () => controller.abort());
        return stream;
    });
    await assert.rejects(createArchive([file], output, { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(fs.access(output), { code: "ENOENT" });
});
