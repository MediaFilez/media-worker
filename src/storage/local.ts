import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia, StorageOptions, StorageIdentity } from "./storage.js";
import { identityKey, assertFingerprint } from "./identity.js";
import { assertTempDiskSpace, createRequestTempDir, cleanupStaleTempDirs } from "../media-core/utils/temp.js";
import { trackTempDirectory, checkJobTempBudget } from "../media-core/utils/resources.js";

const STAGING_PREFIX = "mediaworker-storage-";

async function copyArtifact(artifact: MediaArtifact, destination: string, signal?: AbortSignal) {
    let bytes = 0;
    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > artifact.sizeBytes ? new Error("The upload source changed during storage.") : null, chunk);
        },
    });
    await pipeline(createReadStream(artifact.filePath), limiter, createWriteStream(destination, { flags: "wx" }), { signal });
}

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
    private prepared?: Promise<void>;

    constructor(rootDir: string) {
        this.rootDir = path.resolve(rootDir);
    }

    async find(options: StorageOptions & { identity: StorageIdentity }): Promise<StoredMedia | null> {
        options.signal?.throwIfAborted();
        if (options.public) throw new Error("Public media delivery requires a dedicated R2 bucket.");
        const key = identityKey(options.identity);
        const location = path.join(this.rootDir, ...key.split("/"));
        let record;
        try {
            record = JSON.parse(await fs.readFile(path.join(path.dirname(location), "metadata.json"), "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                // An existing directory without metadata is corrupt, not a reusable empty slot.
                const exists = await fs.stat(path.dirname(location)).catch(() => null);
                if (!exists) return null;
            }
            throw new Error("The stored job result metadata is missing or invalid.", { cause: error });
        }
        assertFingerprint(record.fingerprint, options.identity);
        const stat = await fs.stat(location);
        if (!stat.isFile() || stat.size !== record.result.sizeBytes) throw new Error("The stored job result is incomplete.");
        return { ...record.result, key, location };
    }

    async put(artifact: MediaArtifact, options: StorageOptions = {}): Promise<StoredMedia> {
        if (options.public) throw new Error("Public media delivery requires a dedicated R2 bucket.");
        options.signal?.throwIfAborted();
        if (options.identity) return this.putIdentified(artifact, { ...options, identity: options.identity });
        const key = defaultKey(artifact);
        const destination = path.resolve(this.rootDir, ...key.split("/"));
        if (destination !== this.rootDir && !destination.startsWith(`${this.rootDir}${path.sep}`)) {
            throw new TypeError("Storage key escaped the configured storage directory.");
        }

        await fs.mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${crypto.randomUUID()}.partial`;
        try {
            await assertTempDiskSpace(path.dirname(destination), artifact.sizeBytes);
            await copyArtifact(artifact, temporary, options.signal);
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

    private async putIdentified(artifact: MediaArtifact, options: StorageOptions & { identity: StorageIdentity }): Promise<StoredMedia> {
        const existing = await this.find(options);
        if (existing) return existing;
        const key = identityKey(options.identity);
        const destination = path.join(this.rootDir, ...key.split("/"));
        const parent = path.dirname(path.dirname(destination));
        this.prepared ??= (async () => {
            await fs.mkdir(parent, { recursive: true });
            await cleanupStaleTempDirs({ rootDir: parent, prefix: STAGING_PREFIX });
        })().catch((error: unknown) => {
            this.prepared = undefined;
            throw error;
        });
        await this.prepared;
        await assertTempDiskSpace(parent, artifact.sizeBytes);
        const staging = await createRequestTempDir({ rootDir: parent, prefix: STAGING_PREFIX });
        const untrack = trackTempDirectory(staging);
        try {
            await copyArtifact(artifact, path.join(staging, "artifact"), options.signal);
            const sizeBytes = (await fs.stat(path.join(staging, "artifact"))).size;
            if (sizeBytes !== artifact.sizeBytes) throw new Error("The upload source changed during storage.");
            const result = { key, sizeBytes, contentType: artifact.mime, fileName: artifact.fileName, location: destination };
            await fs.writeFile(path.join(staging, "metadata.json"), JSON.stringify({ fingerprint: options.identity.fingerprint, result }));
            await checkJobTempBudget();
            options.signal?.throwIfAborted();
            try {
                // Rename a complete nonempty directory. A concurrent winner cannot be replaced.
                await fs.rename(staging, path.dirname(destination));
            } catch (error) {
                const winner = await this.find(options);
                if (winner) return winner;
                throw error;
            }
            options.onCreated?.();
            return result;
        } finally {
            untrack();
            await fs.rm(staging, { recursive: true, force: true });
        }
    }

    async delete(requestedKey: string, options: { public?: boolean; signal?: AbortSignal } = {}): Promise<void> {
        options.signal?.throwIfAborted();
        if (options.public) throw new Error("Public media delivery requires a dedicated R2 bucket.");
        const key = safeKey(requestedKey);
        const destination = path.resolve(this.rootDir, ...key.split("/"));
        if (!destination.startsWith(`${this.rootDir}${path.sep}`)) {
            throw new TypeError("Storage key escaped the configured storage directory.");
        }
        await fs.rm(destination, { force: true });
        if (/^jobs\/[a-f0-9]{64}\/artifact$/.test(key)) {
            await fs.rm(path.join(path.dirname(destination), "metadata.json"), { force: true });
            await fs.rmdir(path.dirname(destination)).catch(() => undefined);
        }
    }
}
