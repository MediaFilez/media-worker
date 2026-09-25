import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import type { MediaArtifact } from "./types.js";

export async function createArchive(
    files: readonly MediaArtifact[],
    outputPath: string,
    options: { signal?: AbortSignal } = {},
): Promise<MediaArtifact> {
    if (files.length === 0) throw new TypeError("Cannot create an empty archive.");
    await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });

    const archive = archiver("zip", { zlib: { level: 6 } });
    const output = fs.createWriteStream(outputPath, { flags: "wx" });
    const abort = () => archive.abort();
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
        for (const file of files) archive.file(file.filePath, { name: file.fileName });
        const completion = pipeline(archive, output, { signal: options.signal });
        await archive.finalize();
        await completion;
        const stat = await fsPromises.stat(outputPath);
        return {
            filePath: outputPath,
            fileName: path.basename(outputPath),
            sizeBytes: stat.size,
            mime: "application/zip",
            extension: "zip",
            mediaKind: "unknown",
        };
    } catch (error) {
        await fsPromises.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        options.signal?.removeEventListener("abort", abort);
    }
}
