import fs from "node:fs/promises";
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

    let artifact: MediaArtifact = download;
    const needsProcessing =
        effectiveOutputType !== "auto" ||
        job.output.format !== "original" ||
        Boolean(job.output.maxBytes && download.sizeBytes > job.output.maxBytes);
    if (needsProcessing) {
        artifact = await core.processMedia(download, {
            outputType: effectiveOutputType,
            format: job.output.format,
            maxOutputBytes: job.output.maxBytes,
            allowCompression: job.output.allowCompression,
            tempDir: jobDir,
            signal: context.signal,
            onProgress: context.onProgress,
        });
    }

    context.signal.throwIfAborted();
    return artifact;
}

export async function executeDownloadJob(
    job: DownloadJob,
    jobDir: string,
    dependencies: DownloadJobDependencies,
    context: JobContext,
): Promise<StoredMedia> {
    context.signal.throwIfAborted();
    const storageOptions = { signal: context.signal, public: job.delivery === "public", identity: storageIdentity(job, "original") };
    const thumbnailOptions = { ...storageOptions, identity: storageIdentity(job, "thumbnail") };
    const existing = await dependencies.storage.find?.(storageOptions);
    if (existing) {
        const thumbnail = job.delivery === "public" ? await dependencies.storage.find?.(thumbnailOptions) : null;
        return thumbnail ? { ...existing, thumbnailKey: thumbnail.key } : existing;
    }
    const artifact = await downloadAndProcess(job, jobDir, dependencies.core, context);
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
        const thumbnail = await dependencies.core.processMedia(artifact, {
            outputType: "thumbnail",
            tempDir: jobDir,
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
