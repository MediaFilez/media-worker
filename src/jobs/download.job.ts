import fs from "node:fs/promises";
import path from "node:path";
import type { MediaCore } from "../media-core/index.js";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia } from "../storage/storage.js";
import type { DownloadJob } from "./schema.js";
import type { JobContext } from "./types.js";
import { config } from "../media-core/config.js";
import { assertTempDiskSpace } from "../media-core/utils/temp.js";
import { storageIdentity } from "../storage/identity.js";
import { redactSensitive } from "../media-core/utils/errors.js";

export interface DownloadJobDependencies {
    core: MediaCore;
    storage: MediaStorage;
}

export async function downloadAndProcess(job: DownloadJob, jobDir: string, core: MediaCore, context: JobContext): Promise<MediaArtifact> {
    context.signal.throwIfAborted();
    const effectiveOutputType =
        job.output.quality === "audio-only" || job.output.format === "mp3"
            ? "audio"
            : job.output.format === "mp4"
              ? "video"
              : job.output.format === "jpg"
                ? "image"
                : job.output.type;
    const maxDownloadBytes = Math.min(job.maxDownloadBytes ?? config.maxDownloadBytes, config.maxDownloadBytes);
    await fs.mkdir(jobDir, { recursive: true });
    await assertTempDiskSpace(jobDir, maxDownloadBytes);
    const download = await core.downloadMedia(job.url, jobDir, {
        outputType: effectiveOutputType,
        quality: job.output.quality,
        maxBytes: maxDownloadBytes,
        signal: context.signal,
        onProgress: context.onProgress,
    });
    context.signal.throwIfAborted();

    const items: MediaArtifact[] = [];
    for (const [index, item] of (download.items ?? [download]).entries()) {
        context.signal.throwIfAborted();
        let artifact = item;
        const needsProcessing =
            effectiveOutputType !== "auto" ||
            job.output.format !== "original" ||
            Boolean(job.output.maxBytes && item.sizeBytes > job.output.maxBytes);
        if (needsProcessing) {
            const tempDir = download.items ? path.join(jobDir, `process-${index + 1}`) : jobDir;
            await fs.mkdir(tempDir, { recursive: true });
            artifact = await core.processMedia(item, {
                outputType: effectiveOutputType,
                format: job.output.format,
                maxOutputBytes: job.output.maxBytes,
                allowCompression: job.output.allowCompression,
                tempDir,
                signal: context.signal,
                onProgress: context.onProgress,
            });
        }
        items.push(artifact);
    }

    context.signal.throwIfAborted();
    return items.length === 1 ? items[0]! : { ...items[0]!, items };
}

export async function executeDownloadJob(
    job: DownloadJob,
    jobDir: string,
    dependencies: DownloadJobDependencies,
    context: JobContext,
): Promise<StoredMedia & { items?: StoredMedia[] }> {
    context.signal.throwIfAborted();
    const storageOptions = { signal: context.signal, public: job.delivery === "public", identity: storageIdentity(job, "original") };
    const thumbnailOptions = { ...storageOptions, identity: storageIdentity(job, "thumbnail") };
    const existing = await dependencies.storage.find?.(storageOptions);
    if (existing) {
        if (existing.collectionSize) {
            const items = await readStoredCollection(job, existing, dependencies.storage, context);
            return { ...items[0]!, items };
        }
        const thumbnail = job.delivery === "public" ? await dependencies.storage.find?.(thumbnailOptions) : null;
        return thumbnail ? { ...existing, thumbnailKey: thumbnail.key } : existing;
    }
    const artifact = await downloadAndProcess(job, jobDir, dependencies.core, context);
    if (artifact.items) {
        const items: StoredMedia[] = [];
        for (let index = 1; index < artifact.items.length; index++) {
            context.signal.throwIfAborted();
            items[index] = await storeArtifact(
                { ...job, jobId: `${job.jobId}:item:${index}` },
                artifact.items[index]!,
                jobDir,
                dependencies,
                context,
            );
        }
        // The primary object is the commit marker. Every sibling must exist first.
        const primary = await storeArtifact(job, { ...artifact.items[0]!, collectionSize: artifact.items.length }, jobDir, dependencies, context);
        if (dependencies.storage.find) {
            const committed = await readStoredCollection(job, primary, dependencies.storage, context);
            return { ...committed[0]!, items: committed };
        }
        items[0] = primary;
        return { ...primary, items };
    }
    return storeArtifact(job, artifact, jobDir, dependencies, context);
}

async function readStoredCollection(job: DownloadJob, primary: StoredMedia, storage: MediaStorage, context: JobContext): Promise<StoredMedia[]> {
    const count = primary.collectionSize ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("Stored collection metadata is invalid.");
    const items: StoredMedia[] = [];
    for (let index = 0; index < count; index++) {
        context.signal.throwIfAborted();
        const itemJob = index === 0 ? job : { ...job, jobId: `${job.jobId}:item:${index}` };
        const options = { signal: context.signal, public: job.delivery === "public" };
        const item = index === 0 ? primary : await storage.find!({ ...options, identity: storageIdentity(itemJob, "original") });
        if (!item) throw new Error("The stored collection is incomplete.");
        const thumbnail = job.delivery === "public" ? await storage.find!({ ...options, identity: storageIdentity(itemJob, "thumbnail") }) : null;
        items.push(thumbnail ? { ...item, thumbnailKey: thumbnail.key } : item);
    }
    return items;
}

async function storeArtifact(
    job: DownloadJob,
    artifact: MediaArtifact,
    jobDir: string,
    dependencies: DownloadJobDependencies,
    context: JobContext,
): Promise<StoredMedia> {
    const storageOptions = { signal: context.signal, public: job.delivery === "public", identity: storageIdentity(job, "original") };
    const thumbnailOptions = { ...storageOptions, identity: storageIdentity(job, "thumbnail") };
    await context.onProgress?.({ phase: "storing", detail: "Storing the completed artifact" });
    context.signal.throwIfAborted();
    let created = !dependencies.storage.find;
    const stored = await dependencies.storage.put(artifact, {
        ...storageOptions,
        onCreated: () => {
            created = true;
        },
    });
    // Only the original commit's winner may derive its preview from this local artifact.
    if (!created) {
        const thumbnail = job.delivery === "public" ? await dependencies.storage.find?.(thumbnailOptions) : null;
        return thumbnail ? { ...stored, thumbnailKey: thumbnail.key } : stored;
    }
    if (job.delivery !== "public" || artifact.mediaKind !== "video" || context.signal?.aborted) return stored;

    try {
        const tempDir = path.join(jobDir, `thumbnail-${storageOptions.identity.fingerprint.slice(0, 16)}`);
        await fs.mkdir(tempDir, { recursive: true });
        const thumbnail = await dependencies.core.processMedia(artifact, {
            outputType: "thumbnail",
            tempDir,
            maxOutputBytes: 2 * 1024 * 1024,
            allowCompression: true,
            signal: context.signal,
        });
        const storedThumbnail = await dependencies.storage.put(thumbnail, thumbnailOptions);
        return { ...stored, thumbnailKey: storedThumbnail.key };
    } catch (error) {
        const message = redactSensitive(error instanceof Error ? error.message : String(error));
        console.warn(JSON.stringify({ level: "warn", event: "media.thumbnail.failed", jobId: job.jobId, message }));
        return stored;
    }
}
