import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export class ProcessExecutionError extends Error {
    constructor(command, result, options = {}) {
        super(`${command} exited with code ${result.exitCode ?? "unknown"}.`);
        this.name = "ProcessExecutionError";
        this.command = command;
        this.exitCode = result.exitCode;
        this.stdout = result.stdout;
        this.stderr = result.stderr;
        this.timedOut = options.timedOut ?? false;
        this.aborted = options.aborted ?? false;
        this.cause = options.cause;
    }
}

function appendCapped(current, chunk) {
    const next = current + chunk;
    return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function emitLines(buffer, chunk, callback) {
    const combined = buffer + chunk;
    const lines = combined.split(/\r?\n|\r/g);
    const unfinished = lines.pop() ?? "";
    const remainder = unfinished.length > MAX_CAPTURE_BYTES ? unfinished.slice(-MAX_CAPTURE_BYTES) : unfinished;
    if (callback) {
        for (const line of lines) {
            if (line) callback(line.replace(/\x1b\[[0-9;]*m/g, ""));
        }
    }
    return remainder;
}

function stopProcess(child) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
        });
        killer.unref();
        return;
    }
    try {
        process.kill(-child.pid, "SIGKILL");
    } catch {
        child.kill("SIGKILL");
    }
}

export function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let stdoutRemainder = "";
        let stderrRemainder = "";
        let timedOut = false;
        let aborted = false;

        const timeout = options.timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  stopProcess(child);
              }, options.timeoutMs)
            : null;

        const abort = () => {
            aborted = true;
            stopProcess(child);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();

        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            stdout = appendCapped(stdout, text);
            if (options.onStdoutLine) stdoutRemainder = emitLines(stdoutRemainder, text, options.onStdoutLine);
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            stderr = appendCapped(stderr, text);
            if (options.onStderrLine) stderrRemainder = emitLines(stderrRemainder, text, options.onStderrLine);
        });

        child.once("error", (error) => {
            if (timeout) clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            reject(new ProcessExecutionError(command, { exitCode: null, stdout, stderr }, { timedOut, aborted, cause: error }));
        });
        child.once("close", (exitCode) => {
            if (timeout) clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            if (stdoutRemainder && options.onStdoutLine) options.onStdoutLine(stdoutRemainder);
            if (stderrRemainder && options.onStderrLine) options.onStderrLine(stderrRemainder);
            const result = { exitCode, stdout, stderr };
            if (exitCode === 0 && !timedOut && !aborted) resolve(result);
            else reject(new ProcessExecutionError(command, result, { timedOut, aborted }));
        });
    });
}
