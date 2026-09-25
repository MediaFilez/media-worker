import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./media-core/config.js";
import { createMediaCore, type MediaCore } from "./media-core/index.js";
import type { ProgressUpdate } from "./media-core/types.js";
import { cleanupTempDir, createRequestTempDir, tempOwnershipSignal } from "./media-core/utils/temp.js";
import { executeBatchJob } from "./jobs/batch.job.js";
import { executeCleanupJob } from "./jobs/cleanup.job.js";
import { executeDownloadJob } from "./jobs/download.job.js";
import { workerJobSchema, type WorkerJob } from "./jobs/schema.js";
import type { WorkerResult } from "./jobs/types.js";
import { LocalStorageAdapter } from "./storage/local.js";
import type { MediaStorage } from "./storage/storage.js";

export interface WorkerRuntimeOptions {
    core?: MediaCore;
    storage?: MediaStorage;
    tempRoot?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
}

export interface ExecuteOptions {
    signal?: AbortSignal;
    onProgress?: (update: ProgressUpdate) => void | Promise<void>;
}

function isRetryable(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const candidate = error as Error & { code?: string; stopFallback?: boolean };
    if (candidate.stopFallback) return false;
    if (["INVALID_URL", "PRIVATE_URL", "UNSUPPORTED_MEDIA", "WRONG_MEDIA_TYPE", "FILE_TOO_LARGE"].includes(candidate.code ?? "")) {
        return false;
    }
    return !["AbortError", "ZodError", "TypeError"].includes(candidate.name);
}

export class WorkerRuntime {
    private readonly core: MediaCore;
    private readonly storage: MediaStorage;
    private readonly tempRoot?: string;
    private readonly timeoutMs: number;
    private readonly maxAttempts: number;
    private readonly retryBaseDelayMs: number;

    constructor(options: WorkerRuntimeOptions = {}) {
        this.core = options.core ?? createMediaCore();
        this.storage = options.storage ?? new LocalStorageAdapter(config.storageDir);
        this.tempRoot = options.tempRoot ?? config.tempDir ?? undefined;
        this.timeoutMs = options.timeoutMs ?? config.jobTimeoutMs;
        this.maxAttempts = options.maxAttempts ?? config.maxJobAttempts;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? config.retryBaseDelayMs;
    }

    async execute(input: unknown, options: ExecuteOptions = {}): Promise<WorkerResult> {
        const job = workerJobSchema.parse(input);
        const startedAt = new Date();
        let lastError: unknown;

        if (this.tempRoot) await fs.mkdir(this.tempRoot, { recursive: true });

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
            const signals = [timeoutSignal, tempOwnershipSignal];
            if (options.signal) signals.push(options.signal);
            const signal = AbortSignal.any(signals);
            let jobDir: string | undefined;

            try {
                jobDir = await createRequestTempDir(this.tempRoot ? { rootDir: this.tempRoot } : {});
                const result = await this.executeOnce(job, jobDir, {
                    signal,
                    onProgress: options.onProgress,
                });
                const completedAt = new Date();
                await options.onProgress?.({ phase: "completed", attempt, totalAttempts: this.maxAttempts });
                return {
                    ...result,
                    jobId: job.jobId,
                    type: job.type,
                    attempts: attempt,
                    startedAt: startedAt.toISOString(),
                    completedAt: completedAt.toISOString(),
                    durationMs: completedAt.getTime() - startedAt.getTime(),
                };
            } catch (error) {
                lastError = error;
                if (signal.aborted || attempt >= this.maxAttempts || !isRetryable(error)) throw error;
                const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
                await options.onProgress?.({
                    phase: "retrying",
                    detail: error instanceof Error ? error.message : "Job attempt failed",
                    attempt,
                    totalAttempts: this.maxAttempts,
                });
                await delay(delayMs, undefined, { signal: options.signal });
            } finally {
                await cleanupTempDir(jobDir);
            }
        }

        throw lastError;
    }

    private async executeOnce(
        job: WorkerJob,
        jobDir: string,
        context: ExecuteOptions & { signal: AbortSignal },
    ): Promise<Omit<WorkerResult, "jobId" | "type" | "attempts" | "startedAt" | "completedAt" | "durationMs">> {
        if (job.type === "download") {
            const output = await executeDownloadJob(job, jobDir, { core: this.core, storage: this.storage }, context);
            return { output };
        }
        if (job.type === "batch") {
            const result = await executeBatchJob(job, jobDir, { core: this.core, storage: this.storage }, context);
            return { output: result.archive };
        }
        const cleanedDirectories = await executeCleanupJob(this.tempRoot);
        return { cleanedDirectories };
    }
}
