import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { userError } from "./errors.js";

const context = new AsyncLocalStorage();
export function jobResources() {
    return context.getStore();
}

export function trackTempDirectory(directory) {
    const state = jobResources();
    if (!state) return () => {};
    state.directories.add(directory);
    return () => state.directories.delete(directory);
}

export async function checkJobTempBudget() {
    await jobResources()?.assertDiskLimit();
}

export async function directoryBytes(directory, maxBytes = Infinity) {
    let total = 0;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    for (const entry of entries) {
        const file = path.join(directory, entry.name);
        // Count link metadata without following it out of the owned directory.
        if (entry.isDirectory()) total += await directoryBytes(file, maxBytes - total);
        else
            total += (
                await fs.lstat(file).catch((error) => {
                    if (error.code === "ENOENT") return { size: 0 };
                    throw error;
                })
            ).size;
        if (total > maxBytes) break;
    }
    return total;
}

export async function withJobResources(directory, parentSignal, callback, options = {}) {
    const limit = options.maxTempBytes ?? config.maxJobTempBytes;
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const state = {
        signal,
        maxProcesses: options.maxProcesses ?? config.maxJobProcesses,
        processes: 0,
        waiters: [],
        maxTempBytes: limit,
        mediaInfoCache: new Map(),
        children: new Set(),
        directories: new Set([directory]),
    };
    const measure = async () => {
        let total = 0;
        for (const owned of state.directories) {
            total += await directoryBytes(owned, limit - total);
            if (total > limit) break;
        }
        return total;
    };
    state.assertDiskLimit = async () => {
        if ((await measure()) > limit) throw userError("Job temporary disk limit exceeded.", "TEMP_LIMIT", { stopFallback: true });
    };
    let stopped = false;
    let pending;
    let timer;
    const check = async () => {
        try {
            if ((await measure()) > limit) controller.abort(userError("Job temporary disk limit exceeded.", "TEMP_LIMIT", { stopFallback: true }));
        } catch {
            if (!stopped) controller.abort(userError("Could not enforce job temporary disk limit.", "TEMP_LIMIT", { stopFallback: true }));
        }
        if (!stopped && !signal.aborted)
            timer = setTimeout(() => {
                pending = check();
            }, options.pollMs ?? config.tempMonitorIntervalMs);
    };
    pending = check();
    try {
        await pending;
        signal.throwIfAborted();
        const result = await context.run(state, () => callback(signal));
        await measure().then((bytes) => {
            if (bytes > limit) controller.abort(userError("Job temporary disk limit exceeded.", "TEMP_LIMIT", { stopFallback: true }));
        });
        signal.throwIfAborted();
        return result;
    } catch (error) {
        signal.throwIfAborted();
        throw error;
    } finally {
        stopped = true;
        clearTimeout(timer);
        controller.abort(Object.assign(new Error("Job execution finished."), { name: "AbortError" }));
        await pending;
        await Promise.allSettled([...state.children]);
    }
}

export async function acquireProcess(signal) {
    const state = jobResources();
    if (!state) return () => {};
    signal?.throwIfAborted();
    while (state.processes >= state.maxProcesses) {
        await new Promise((resolve, reject) => {
            const wake = () => {
                signal?.removeEventListener("abort", abort);
                resolve();
            };
            const abort = () => {
                const index = state.waiters.indexOf(wake);
                if (index >= 0) state.waiters.splice(index, 1);
                reject(signal.reason);
            };
            state.waiters.push(wake);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
        });
        signal?.throwIfAborted();
    }
    state.processes += 1;
    return () => {
        state.processes -= 1;
        state.waiters.shift()?.();
    };
}
