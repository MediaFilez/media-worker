import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import archiver from "archiver";
import type { MediaArtifact } from "./types.js";
import { makeSafeFileName } from "./utils/files.js";
import { userError } from "./utils/errors.js";

export async function createArchive(
    files: readonly MediaArtifact[],
    outputPath: string,
    options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<MediaArtifact> {
    if (files.length === 0) throw new TypeError("Cannot create an empty archive.");
    options.signal?.throwIfAborted();
    if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)) {
        throw new TypeError("Archive maxBytes must be a positive safe integer.");
    }
    await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });

    const archive = archiver("zip", { zlib: { level: 6 } });
    const output = fs.createWriteStream(outputPath, { flags: "wx" });
    let created = false;
    output.once("open", () => {
        created = true;
    });
    // archiver otherwise skips unreadable inputs and completes an incomplete ZIP.
    archive.on("warning", (error) => archive.destroy(error));
    let bytes = 0;
    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.byteLength;
            if (options.maxBytes !== undefined && bytes > options.maxBytes) {
                callback(userError("The ZIP exceeds the configured aggregate size limit.", "BATCH_TOO_LARGE", { stopFallback: true }));
                return;
            }
            callback(null, chunk);
        },
    });
    const abort = () => archive.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let completion: Promise<void> | undefined;

    try {
        const names = new Set<string>();
        for (const file of files) {
            const baseName = makeSafeFileName(path.posix.basename(file.fileName.replaceAll("\\", "/")), "media", file.extension);
            let name = baseName;
            for (let suffix = 2; names.has(name); suffix += 1) name = `${suffix}-${baseName}`;
            names.add(name);
            archive.file(file.filePath, { name });
        }
        completion = pipeline(archive, limiter, output, { signal: options.signal });
        await Promise.all([completion, archive.finalize()]);
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
        archive.abort();
        archive.destroy();
        limiter.destroy();
        output.destroy();
        await completion?.catch(() => undefined);
        await finished(output).catch(() => undefined);
        if (created) await fsPromises.rm(outputPath, { force: true }).catch(() => undefined);
        throw error;
    } finally {
        options.signal?.removeEventListener("abort", abort);
    }
}
