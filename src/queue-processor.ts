import { UnrecoverableError } from "bullmq";
import type { WorkerRuntime } from "./runtime.js";
import { parseApiDownloadJob } from "./jobs/api-contract.js";
import { config } from "./media-core/config.js";
import { isRetryableError, redactSensitive } from "./media-core/utils/errors.js";
import type { ProgressUpdate } from "./media-core/types.js";
import { log } from "./media-core/utils/logger.js";

interface QueueJob {
    data: unknown;
    attemptsMade: number;
    updateProgress(update: ProgressUpdate): Promise<void>;
}

function controlError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

export function createQueueProcessor(
    runtime: Pick<WorkerRuntime, "execute">,
    control: { get(key: string): Promise<string | null> },
    options: { pollMs?: number; maxAttempts?: number; prefix?: string } = {},
) {
    const active = new Set<AbortController>();
    let closed = false;
    const processJob = async (job: QueueJob) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pending: Promise<void> | undefined;
        let finished = false;
        let progressWrite: Promise<void> | undefined;
        active.add(controller);
        try {
            if (closed) throw controlError("The worker is shutting down.", "WORKER_SHUTDOWN");
            const { payload, runtimeJob } = parseApiDownloadJob(job.data);
            const cancelKey = `${options.prefix ?? config.queuePrefix}:cancel:${payload.jobId}`;
            const poll = async () => {
                try {
                    if ((await control.get(cancelKey)) === "1") controller.abort(controlError("Job cancelled.", "JOB_CANCELLED"));
                } catch {
                    controller.abort(controlError("The cancellation service is unavailable.", "CONTROL_UNAVAILABLE"));
                }
            };
            await poll();
            controller.signal.throwIfAborted();
            const schedule = () => {
                if (finished || controller.signal.aborted) return;
                timer = setTimeout(() => {
                    pending = poll().then(schedule);
                }, options.pollMs ?? 500);
            };
            schedule();
            const onProgress = (update: ProgressUpdate) => {
                // Keep at most one outstanding Redis progress command, and never wait for it.
                if (progressWrite || finished || controller.signal.aborted) return;
                progressWrite = Promise.resolve()
                    .then(() => job.updateProgress(update))
                    .catch(() => {
                        log.warn("Queue progress update failed.");
                    })
                    .finally(() => {
                        progressWrite = undefined;
                    });
            };
            try {
                return await runtime.execute(runtimeJob, { signal: controller.signal, onProgress });
            } catch (error) {
                controller.signal.throwIfAborted();
                throw error;
            }
        } catch (error) {
            const exhausted = job.attemptsMade >= (options.maxAttempts ?? config.maxJobAttempts) - 1;
            if (!isRetryableError(error) || exhausted) {
                throw new UnrecoverableError(error instanceof Error ? redactSensitive(error.message) : "Job failed.");
            }
            throw error;
        } finally {
            finished = true;
            clearTimeout(timer);
            // No Redis writes after a storage commit. Cancellation flags expire at their producer's TTL.
            active.delete(controller);
            // A pending GET is bounded by the control client's command timeout.
            await pending;
        }
    };
    return {
        processJob,
        shutdown() {
            closed = true;
            for (const controller of active) controller.abort(controlError("The worker is shutting down.", "WORKER_SHUTDOWN"));
        },
    };
}
