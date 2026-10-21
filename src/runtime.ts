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
import { createDefaultStorage } from "./storage/default.js";
import type { MediaStorage } from "./storage/storage.js";
import { log } from "./media-core/utils/logger.js";
import { withJobResources } from "./media-core/utils/resources.js";
import { isRetryableError, redactSensitive } from "./media-core/utils/errors.js";

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

export class WorkerRuntime {
    private readonly core: MediaCore;
    private readonly storage: MediaStorage;
    private readonly tempRoot?: string;
    private readonly timeoutMs: number;
    private readonly maxAttempts: number;
    private readonly retryBaseDelayMs: number;

    constructor(options: WorkerRuntimeOptions = {}) {
        this.core = options.core ?? createMediaCore();
        this.storage = options.storage ?? createDefaultStorage();
        this.tempRoot = options.tempRoot ?? config.tempDir ?? undefined;
        this.timeoutMs = options.timeoutMs ?? config.jobTimeoutMs;
        this.maxAttempts = options.maxAttempts ?? config.maxJobAttempts;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? config.retryBaseDelayMs;
    }

    async execute(input: unknown, options: ExecuteOptions = {}): Promise<WorkerResult> {
        const job = workerJobSchema.parse(input);
        const startedAt = new Date();
        let lastError: unknown;
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signals = [timeoutSignal, tempOwnershipSignal];
        if (options.signal) signals.push(options.signal);
        const signal = AbortSignal.any(signals);
        const onProgress = options.onProgress
            ? async (update: ProgressUpdate) => {
                  try {
                      await options.onProgress!(update);
                  } catch {
                      log.warn("Job progress update failed.");
                  }
              }
            : undefined;

        signal.throwIfAborted();
        if (this.tempRoot) await fs.mkdir(this.tempRoot, { recursive: true });

        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
            signal.throwIfAborted();
            let jobDir: string | undefined;

            try {
                jobDir = await createRequestTempDir(this.tempRoot ? { rootDir: this.tempRoot } : {});
                signal.throwIfAborted();
                const result = await withJobResources(jobDir, signal, (resourceSignal: AbortSignal) =>
                    this.executeOnce(job, jobDir!, {
                        signal: resourceSignal,
                        onProgress,
                    }),
                );
                const completedAt = new Date();
                await onProgress?.({ phase: "completed", attempt, totalAttempts: this.maxAttempts });
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
                signal.throwIfAborted();
                if (attempt >= this.maxAttempts || !isRetryableError(error)) throw error;
            } finally {
                await cleanupTempDir(jobDir);
            }
            const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
            await onProgress?.({
                phase: "retrying",
                detail: lastError instanceof Error ? redactSensitive(lastError.message) : "Job attempt failed",
                attempt,
                totalAttempts: this.maxAttempts,
            });
            try {
                await delay(delayMs, undefined, { signal });
            } catch (error) {
                signal.throwIfAborted();
                throw error;
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
