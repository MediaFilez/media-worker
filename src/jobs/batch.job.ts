import path from "node:path";
import { createArchive } from "../media-core/archive.js";
import type { MediaCore } from "../media-core/index.js";
import type { MediaArtifact } from "../media-core/types.js";
import type { MediaStorage, StoredMedia } from "../storage/storage.js";
import type { BatchJob } from "./schema.js";
import type { JobContext } from "./types.js";
import { downloadAndProcess } from "./download.job.js";
import { config } from "../media-core/config.js";
import { assertTempDiskSpace } from "../media-core/utils/temp.js";
import { userError } from "../media-core/utils/errors.js";

export async function executeBatchJob(
    job: BatchJob,
    jobDir: string,
    dependencies: { core: MediaCore; storage: MediaStorage },
    context: JobContext,
): Promise<{ archive: StoredMedia; items: MediaArtifact[] }> {
    const artifacts: MediaArtifact[] = [];
    let totalBytes = 0;
    for (const [index, item] of job.items.entries()) {
        const itemDir = path.join(jobDir, `item-${String(index + 1).padStart(3, "0")}`);
        const remainingBytes = config.maxBatchBytes - totalBytes;
        if (remainingBytes <= 0) {
            throw userError("The batch exceeds the configured aggregate size limit.", "BATCH_TOO_LARGE", { stopFallback: true });
        }
        await assertTempDiskSpace(jobDir, Math.min(remainingBytes, config.maxBatchBytes));
        const artifact = await downloadAndProcess(
            {
                ...item,
                type: "download",
                jobId: `${job.jobId}:${index + 1}`,
                maxDownloadBytes: Math.min(item.maxDownloadBytes ?? config.maxDownloadBytes, remainingBytes),
            },
            itemDir,
            dependencies.core,
            context,
        );
        artifacts.push(artifact);
        totalBytes += artifact.sizeBytes;
    }

    await context.onProgress?.({ phase: "processing", detail: "Creating ZIP archive" });
    await assertTempDiskSpace(jobDir, Math.min(totalBytes, config.maxBatchBytes));
    const archiveName = `${path.basename(job.archiveName, path.extname(job.archiveName)) || "media"}.zip`;
    const archive = await createArchive(artifacts, path.join(jobDir, archiveName), { signal: context.signal });
    await context.onProgress?.({ phase: "storing", detail: "Storing ZIP archive" });
    return { archive: await dependencies.storage.put(archive, { signal: context.signal }), items: artifacts };
}
