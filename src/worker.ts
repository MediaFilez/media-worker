import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WorkerRuntime } from "./runtime.js";

export async function runJobFile(filePath: string): Promise<void> {
    const input = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const runtime = new WorkerRuntime();
    const result = await runtime.execute(input, {
        onProgress(update) {
            process.stderr.write(`${JSON.stringify({ event: "progress", ...update })}\n`);
        },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
    const filePath = process.argv[2];
    if (!filePath) {
        process.stderr.write("Usage: node dist/worker.js <job.json>\n");
        process.exitCode = 2;
    } else {
        runJobFile(filePath).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`${JSON.stringify({ event: "failed", message })}\n`);
            process.exitCode = 1;
        });
    }
}
