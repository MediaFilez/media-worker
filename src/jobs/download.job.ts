import type { MediaCore } from "../media-core/index.js";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia } from "../storage/storage.js";
import type { DownloadJob } from "./schema.js";
import type { JobContext } from "./types.js";
import { config } from "../media-core/config.js";
import { assertTempDiskSpace } from "../media-core/utils/temp.js";

export interface DownloadJobDependencies {
    core: MediaCore;
    storage: MediaStorage;
}

export async function downloadAndProcess(job: DownloadJob, jobDir: string, core: MediaCore, context: JobContext): Promise<MediaArtifact> {
    const effectiveOutputType =
        job.output.format === "mp3" ? "audio" : job.output.format === "mp4" ? "video" : job.output.format === "jpg" ? "image" : job.output.type;
    const maxDownloadBytes = Math.min(job.maxDownloadBytes ?? config.maxDownloadBytes, config.maxDownloadBytes);
    await assertTempDiskSpace(jobDir, maxDownloadBytes);
    const download = await core.downloadMedia(job.url, jobDir, {
        outputType: effectiveOutputType,
        quality: job.output.quality,
        maxBytes: maxDownloadBytes,
        signal: context.signal,
        onProgress: context.onProgress,
    });

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

    return artifact;
}

export async function executeDownloadJob(
    job: DownloadJob,
    jobDir: string,
    dependencies: DownloadJobDependencies,
    context: JobContext,
): Promise<StoredMedia> {
    const artifact = await downloadAndProcess(job, jobDir, dependencies.core, context);
    await context.onProgress?.({ phase: "storing", detail: "Storing the completed artifact" });
    return await dependencies.storage.put(artifact);
}
