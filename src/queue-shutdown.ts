export async function shutdownQueueWorker(
    worker: { close(): Promise<void> },
    control: { disconnect(): void },
    processor: { shutdown(): void },
    graceMs: number,
): Promise<void> {
    processor.shutdown();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            worker.close(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Worker shutdown exceeded its grace period.")), graceMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        control.disconnect();
    }
}
