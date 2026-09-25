import type { ProgressUpdate } from "../media-core/types.js";
import type { StoredMedia } from "../storage/storage.js";

export interface JobContext {
    signal: AbortSignal;
    onProgress?: (update: ProgressUpdate) => void | Promise<void>;
}

export interface WorkerResult {
    jobId: string;
    type: "download" | "batch" | "cleanup";
    attempts: number;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    output?: StoredMedia;
    items?: StoredMedia[];
    cleanedDirectories?: number;
}
