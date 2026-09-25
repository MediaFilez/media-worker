import { MB } from "../config.js";

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / MB).toFixed(1)} MB`;
}

export function formatElapsed(ms) {
    if (!Number.isFinite(ms)) return "unknown";
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;

    const minutes = Math.floor(ms / 60_000);
    const seconds = ((ms % 60_000) / 1000).toFixed(1);
    return `${minutes}m ${seconds}s`;
}

export function summarizeAttempts(attempts = []) {
    return attempts.map((attempt) => `${attempt.method}: ${attempt.error}`).join(" | ");
}
