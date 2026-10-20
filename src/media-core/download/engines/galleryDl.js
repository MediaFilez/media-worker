import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { DownloadMethodError } from "../../utils/errors.js";
import { ProcessExecutionError, runProcess, childEnvironment } from "../../utils/process.js";
import { recoverArtifact } from "../artifact.js";
import { withEngineProxy } from "../../utils/engineProxy.js";
import { ytDlpFormatSelector } from "../videoQuality.js";
import { copyCookiesForAttempt } from "../../utils/cookies.js";

/**
 * Selects the gallery-dl executable path from configuration, a bundled binary, or the system PATH.
 * @returns {string} The configured path, bundled executable path, or `"gallery-dl"` for PATH resolution.
 */
export function resolveGalleryDlPath() {
    if (config.galleryDlPath) return config.galleryDlPath;
    const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const bundledName = process.platform === "win32" ? "gallery-dl.exe" : "gallery-dl";
    const bundledPath = path.join(projectRoot, ".tools", bundledName);
    return fsSync.existsSync(bundledPath) ? bundledPath : "gallery-dl";
}

async function readMetadata(attemptDir) {
    const entries = await fs.readdir(attemptDir, { recursive: true }).catch(() => []);
    const metadataName = entries.find((name) => typeof name === "string" && name.endsWith(".json"));
    if (!metadataName) return null;
    try {
        const data = JSON.parse(await fs.readFile(path.join(attemptDir, metadataName), "utf8"));
        return {
            title: data.title || data.description,
            creator: data.author?.name || data.author || data.username,
            sourceUrl: data.post_url || data.url,
            sourceId: data.id || data.post_id,
            extractor: data.category || data.extractor,
        };
    } catch {
        return null;
    }
}

function processMessage(error) {
    if (error?.cause?.code === "ENOENT") {
        return "gallery-dl is unavailable. Set GALLERY_DL_PATH to an installed binary, or use the Worker Docker image.";
    }
    const lines = `${error?.stderr || ""}\n${error?.stdout || ""}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.findLast((line) => /error|failed|unsupported/i.test(line)) || lines.at(-1) || error.message;
}

/**
 * Builds the gallery-dl arguments for downloading media from a source URL.
 * @param {string} rawUrl - The source URL to download.
 * @param {string} attemptDir - The directory where gallery-dl stores output and metadata.
 * @param {Object} [options] - Download options.
 * @param {number} [options.maxBytes] - Maximum allowed file size in bytes.
 * @return {string[]} The gallery-dl command-line arguments.
 */
export function galleryDlArgs(rawUrl, attemptDir, options = {}) {
    const maxBytes = options.maxBytes ?? config.maxDownloadBytes;
    const args = [
        "--ignore-config",
        "-o",
        "extractor.proxy-env=false",
        "-o",
        `extractor.ytdl.format=${ytDlpFormatSelector(options.outputType ?? "video", options.targetBytes, options.maxHeight)}`,
        "-o",
        `downloader.ytdl.format=${ytDlpFormatSelector(options.outputType ?? "video", options.targetBytes, options.maxHeight)}`,
        "--no-input",
        "--no-colors",
        "--directory",
        attemptDir,
        "--range",
        "1",
        "--write-metadata",
        "--write-info-json",
        "--retries",
        String(config.galleryDlRetries),
        "--sleep-retries",
        "0",
        "--http-timeout",
        String(config.galleryDlHttpTimeoutSeconds),
        "--filesize-max",
        String(maxBytes),
        "--filename",
        "{title[:120]}_{id}.{extension}",
        "--",
        rawUrl,
    ];
    if (options.cookieFile) args.unshift("--cookies", options.cookieFile);
    return args;
}

/**
 * Downloads a playable artifact from a URL using gallery-dl.
 * @param {string} rawUrl - The source URL to download.
 * @param {string} attemptDir - Directory used for download output and metadata.
 * @param {Object} [options] - Download and artifact recovery options.
 * @returns {Promise<Object>} The recovered artifact with gallery-dl method information, source URL, metadata, and process-error recovery status.
 * @throws {Error} If the download is cancelled.
 * @throws {DownloadMethodError} If gallery-dl fails or produces no playable file.
 */
export async function downloadWithGalleryDl(rawUrl, attemptDir, options = {}) {
    const cookieFile = await copyCookiesForAttempt(config.mediaCookiesFile, attemptDir);
    const args = galleryDlArgs(rawUrl, attemptDir, { ...options, cookieFile });

    let processError = null;
    try {
        await withEngineProxy(options.signal, (proxy, signal) =>
            (options.processRunner ?? runProcess)(
                resolveGalleryDlPath(),
                [
                    "--proxy",
                    proxy,
                    "-o",
                    `extractor.ytdl.raw-options=${JSON.stringify({ proxy })}`,
                    "-o",
                    `downloader.ytdl.raw-options=${JSON.stringify({ proxy })}`,
                    ...args,
                ],
                {
                    env: childEnvironment(proxy),
                    timeoutMs: config.galleryDlTimeoutMs,
                    signal,
                },
            ),
        );
    } catch (error) {
        if (error?.stopFallback) throw error;
        if (error instanceof ProcessExecutionError && error.aborted)
            throw Object.assign(new Error("The download was cancelled."), { name: "AbortError" });
        processError = error;
    }

    const artifact = await recoverArtifact(attemptDir, {
        outputType: options.outputType,
        maxBytes: options.maxBytes,
        signal: options.signal,
    });
    if (artifact) {
        return {
            ...artifact,
            method: "gallery-dl",
            sourceUrl: rawUrl,
            metadata: await readMetadata(attemptDir),
            recoveredFromProcessError: Boolean(processError),
        };
    }
    throw new DownloadMethodError("gallery-dl", processError ? processMessage(processError) : "gallery-dl produced no playable file.");
}
