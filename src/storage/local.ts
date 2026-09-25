import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia } from "./storage.js";

function safeKey(input: string): string {
    const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
        throw new TypeError("Storage keys must be relative and cannot contain traversal segments.");
    }
    return parts.join("/");
}

function defaultKey(artifact: MediaArtifact): string {
    const day = new Date().toISOString().slice(0, 10);
    return `${day}/${crypto.randomUUID()}-${path.basename(artifact.fileName)}`;
}

export class LocalStorageAdapter implements MediaStorage {
    readonly rootDir: string;

    constructor(rootDir: string) {
        this.rootDir = path.resolve(rootDir);
    }

    async put(artifact: MediaArtifact, options: { signal?: AbortSignal } = {}): Promise<StoredMedia> {
        options.signal?.throwIfAborted();
        const key = defaultKey(artifact);
        const destination = path.resolve(this.rootDir, ...key.split("/"));
        if (destination !== this.rootDir && !destination.startsWith(`${this.rootDir}${path.sep}`)) {
            throw new TypeError("Storage key escaped the configured storage directory.");
        }

        await fs.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${crypto.randomUUID()}.partial`;
        try {
            await fs.copyFile(artifact.filePath, temporary);
            options.signal?.throwIfAborted();
            await fs.rename(temporary, destination);
        } finally {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
        }

        const stat = await fs.stat(destination);
        return {
            key,
            sizeBytes: stat.size,
            contentType: artifact.mime,
            fileName: artifact.fileName,
            location: destination,
        };
    }

    async delete(requestedKey: string): Promise<void> {
        const key = safeKey(requestedKey);
        const destination = path.resolve(this.rootDir, ...key.split("/"));
        if (!destination.startsWith(`${this.rootDir}${path.sep}`)) {
            throw new TypeError("Storage key escaped the configured storage directory.");
        }
        await fs.rm(destination, { force: true });
    }
}
