import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { log } from "./logger.js";
import { userError } from "./errors.js";
import { formatBytes } from "./format.js";

const TEMP_HOST_ID = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12);
const TEMP_OWNER_ID = crypto.randomBytes(16).toString("hex");
const TEMP_OWNER_PROBE_TIMEOUT_MS = 500;
const tempOwnershipController = new AbortController();
export const tempOwnershipSignal = tempOwnershipController.signal;
let ownerServerPromise;

function validateTempPrefix(prefix) {
    if (typeof prefix !== "string" || prefix.length < 8 || prefix.includes("/") || prefix.includes("\\")) {
        throw new TypeError("TEMP_PREFIX must be a plain name at least eight characters long.");
    }
    return prefix;
}

/**
 * Checks whether the system temporary directory has sufficient free space.
 * @throws {UserFacingError} If available temporary-directory space is below the configured minimum.
 */
export async function assertTempDiskSpace(rootDir = os.tmpdir(), additionalBytes = 0) {
    if (!fs.statfs) return;

    try {
        const stats = await fs.statfs(path.resolve(rootDir));
        const freeBytes = stats.bavail * stats.bsize;
        if (freeBytes < config.minFreeDiskBytes + Math.max(0, additionalBytes)) {
            throw userError(
                `The temp filesystem has only ${formatBytes(freeBytes)} free. Need at least ${formatBytes(config.minFreeDiskBytes)} plus the requested job reserve.`,
                "LOW_DISK_SPACE",
            );
        }
    } catch (error) {
        if (error.name === "UserFacingError") throw error;
        log.warn(`Could not check temp disk space: ${error.message}`);
    }
}

/**
 * Creates an owned request directory that startup cleanup can distinguish from abandoned work.
 * @param {Object} [options] - Optional root and prefix overrides.
 * @param {string} [options.rootDir] - Root directory in which to create the request directory.
 * @param {string} [options.prefix] - Prefix used to identify MediaFilez request directories.
 * @returns {Promise<string>} The created directory path.
 */
export async function createRequestTempDir(options = {}) {
    if (tempOwnershipSignal.aborted) throw tempOwnershipSignal.reason;
    const rootDir = path.resolve(options.rootDir ?? os.tmpdir());
    await assertTempDiskSpace(rootDir);
    const prefix = validateTempPrefix(options.prefix ?? config.tempPrefix);
    await ensureTempOwnerServer();
    const dir = await fs.mkdtemp(path.join(rootDir, `${prefix}${TEMP_HOST_ID}-${TEMP_OWNER_ID}-`));
    log.debug("Created temp dir:", dir);
    return dir;
}

function tempOwnerEndpoint(ownerId) {
    if (process.platform === "win32") return `\\\\.\\pipe\\mediafilez-${ownerId}`;
    return path.join(os.tmpdir(), `.mediafilez-${ownerId}.sock`);
}

function ensureTempOwnerServer() {
    if (ownerServerPromise) return ownerServerPromise;

    const endpoint = tempOwnerEndpoint(TEMP_OWNER_ID);
    ownerServerPromise = new Promise((resolve, reject) => {
        const server = net.createServer((socket) => socket.end());
        const rejectStartup = (error) => {
            ownerServerPromise = undefined;
            reject(error);
        };
        server.once("error", rejectStartup);
        server.listen(endpoint, () => {
            server.off("error", rejectStartup);
            server.on("error", (error) => {
                log.error("Temp ownership server failed:", error);
                tempOwnershipController.abort(
                    userError("Temporary storage ownership was lost. Try the request again after the worker restarts.", "TEMP_OWNERSHIP_LOST", {
                        cause: error,
                    }),
                );
            });
            server.unref();
            if (process.platform !== "win32") {
                process.once("exit", () => {
                    try {
                        fsSync.rmSync(endpoint, { force: true });
                    } catch {}
                });
            }
            resolve(server);
        });
    });
    return ownerServerPromise;
}

function tempOwnerFromName(name, prefix) {
    const match = /^([a-f0-9]{12})-([a-f0-9]{32})-/.exec(name.slice(prefix.length));
    return match ? { hostId: match[1], ownerId: match[2] } : null;
}

async function isTempOwnerActive(owner) {
    if (owner.hostId !== TEMP_HOST_ID) return true;
    const endpoint = tempOwnerEndpoint(owner.ownerId);

    return await new Promise((resolve) => {
        let settled = false;
        const socket = net.createConnection(endpoint);
        const finish = (active) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            resolve(active);
        };
        const timeout = setTimeout(() => finish(true), TEMP_OWNER_PROBE_TIMEOUT_MS);
        socket.once("connect", () => finish(true));
        socket.once("error", (error) => finish(!["ECONNREFUSED", "ENOENT"].includes(error?.code)));
    });
}

/**
 * Removes request directories only after their same-host process owner is proven inactive.
 * @param {Object} [options] - Cleanup options.
 * @param {string} [options.rootDir] - Root directory to scan.
 * @param {string} [options.prefix] - Prefix used to identify stale directories.
 * @param {Function} [options.isOwnerActive] - Ownership probe override used by tests.
 * @returns {Promise<number>} The number of directories removed.
 */
export async function cleanupStaleTempDirs(options = {}) {
    const rootDir = path.resolve(options.rootDir ?? os.tmpdir());
    const prefix = validateTempPrefix(options.prefix ?? config.tempPrefix);
    const ownerIsActive = options.isOwnerActive ?? isTempOwnerActive;
    let entries;
    try {
        entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
        log.warn(`Could not inspect stale temp directories: ${error.message}`);
        return 0;
    }

    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
        const owner = tempOwnerFromName(entry.name, prefix);
        if (!owner) continue;
        const target = path.resolve(rootDir, entry.name);
        if (path.dirname(target) !== rootDir) continue;
        if (await ownerIsActive(owner)) continue;
        try {
            await fs.rm(target, { recursive: true, force: true });
            removed += 1;
        } catch (error) {
            log.warn(`Could not clean stale temp dir ${target}: ${error.message}`);
            continue;
        }
        if (owner.hostId === TEMP_HOST_ID && process.platform !== "win32") {
            try {
                await fs.rm(tempOwnerEndpoint(owner.ownerId), { force: true });
            } catch (error) {
                log.warn(`Could not clean stale temp owner socket for ${target}: ${error.message}`);
            }
        }
    }

    if (removed > 0) log.info(`Cleaned ${removed} stale media temp director${removed === 1 ? "y" : "ies"}.`);
    return removed;
}

export async function cleanupTempDir(dir) {
    if (!dir) return;

    const resolvedDir = path.resolve(dir);
    try {
        await fs.rm(resolvedDir, { recursive: true, force: true });
        log.debug("Cleaned up temp dir:", resolvedDir);
    } catch (error) {
        log.warn(`Could not clean temp dir ${resolvedDir}: ${error.message}`);
    }
}
