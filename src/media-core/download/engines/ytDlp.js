import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { DownloadMethodError, userError } from "../../utils/errors.js";
import { ProcessExecutionError, runProcess } from "../../utils/process.js";
import { recoverArtifact } from "../artifact.js";
import { formatBytes } from "../../utils/format.js";
import { resolveFFmpegPaths } from "../../utils/ffmpeg.js";
import { ytDlpFormatSelector } from "../videoQuality.js";

export function resolveYtDlpPath() {
    if (config.ytdlpPath) return config.ytdlpPath;
    const entry = fileURLToPath(import.meta.resolve("youtube-dl-exec"));
    const packageRoot = path.resolve(path.dirname(entry), "..");
    return path.join(packageRoot, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

function cleanError(error) {
    const lines = `${error.stderr || ""}\n${error.stdout || ""}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.findLast((line) => line.startsWith("ERROR:")) || lines.at(-1) || error.message;
}

async function readMetadata(attemptDir) {
    const files = await fs.readdir(attemptDir).catch(() => []);
    const name = files.find((file) => file.endsWith(".info.json"));
    if (!name) return null;

    const raw = await fs.readFile(path.join(attemptDir, name), "utf8").catch(() => null);
    if (!raw) return null;

    try {
        const data = JSON.parse(raw);
        return {
            title: data.title,
            creator: data.uploader || data.channel,
            durationSeconds: data.duration,
            width: data.width,
            height: data.height,
            thumbnailUrl: data.thumbnail,
            sourceUrl: data.webpage_url,
            sourceId: data.id,
            extractor: data.extractor_key || data.extractor,
        };
    } catch {
        return null;
    }
}

/**
 * Creates a handler that reports parsed download progress records.
 * @param {Object} options - Progress handler options.
 * @param {Function} [options.onProgress] - Callback invoked with downloaded bytes, total bytes, and percentage.
 * @returns {Function} A handler that processes download progress lines.
 */
function progressHandler(options) {
    return (line) => {
        if (!line.startsWith("download:")) return;
        const [, downloaded, total, percent] = line.split("|");
        options.onProgress?.({
            downloadedBytes: Number.parseInt(downloaded, 10) || 0,
            totalBytes: Number.parseInt(total, 10) || null,
            percent: Number.parseFloat(percent) || null,
        });
    };
}

function shouldUseCookies(rawUrl) {
    if (config.ytdlpCookiesForYoutube) return true;
    try {
        const host = new URL(rawUrl).hostname.toLowerCase();
        return !(
            host === "youtu.be" ||
            host === "youtube.com" ||
            host.endsWith(".youtube.com") ||
            host === "youtube-nocookie.com" ||
            host.endsWith(".youtube-nocookie.com")
        );
    } catch {
        return true;
    }
}

/**
 * Prepares a private copy of the configured media cookie file for yt-dlp.
 * @param {string} attemptDir - The directory where the copied cookie file is created.
 * @return {Promise<string|null>} The copied cookie file path, or `null` when no media cookie file is configured.
 */
async function prepareCookieFile(attemptDir, rawUrl) {
    if (!config.mediaCookiesFile || !shouldUseCookies(rawUrl)) return null;

    const cookieFile = path.join(attemptDir, ".yt-dlp-cookies.txt");
    const contents = await fs.readFile(config.mediaCookiesFile);
    await fs.writeFile(cookieFile, contents, { flag: "wx", mode: 0o600 });
    await fs.chmod(cookieFile, 0o600);
    return cookieFile;
}

/**
 * Downloads media or a thumbnail from a URL using yt-dlp.
 * @param {string} rawUrl - The source URL to download.
 * @param {string} attemptDir - Directory where the downloaded artifact and metadata are stored.
 * @param {Object} [options] - Download settings and execution callbacks.
 * @param {number} [options.maxBytes] - Maximum allowed download size in bytes.
 * @param {string} [options.outputType] - Requested output type, such as video, audio, thumbnail, or image.
 * @param {number} [options.targetBytes] - Target size used when selecting a media format.
 * @param {AbortSignal} [options.signal] - Signal used to cancel the download.
 * @param {Function} [options.onProgress] - Callback invoked with download progress updates.
 * @param {Function} [options.processRunner] - Process runner used instead of the default runner.
 * @returns {Promise<Object>} The recovered artifact details, source URL, metadata, download method, and process-error recovery status.
 * @throws {Error} With name `AbortError` when the download is cancelled.
 * @throws {Error} When yt-dlp fails without producing a recoverable artifact.
 */
export async function downloadWithYtDlp(rawUrl, attemptDir, options = {}) {
    const maxBytes = options.maxBytes ?? config.maxDownloadBytes;
    const outputType = options.outputType ?? "video";
    const useCookies = shouldUseCookies(rawUrl);
    const cookieFile = await prepareCookieFile(attemptDir, rawUrl);
    const args = [
        "--no-config",
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--windows-filenames",
        "--trim-filenames",
        "150",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "--extractor-retries",
        "3",
        "--socket-timeout",
        "30",
        "--concurrent-fragments",
        String(config.ytdlpConcurrentFragments),
        "--max-filesize",
        String(maxBytes),
        "--js-runtimes",
        `node:${process.execPath}`,
        "--ffmpeg-location",
        resolveFFmpegPaths().ffmpeg,
        "--write-info-json",
        "--no-clean-info-json",
        "--progress-template",
        "download:%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress._percent_str)s",
        "--print",
        "after_move:filepath",
        "--output",
        path.join(attemptDir, "%(title).120B_%(id).40B.%(ext)s"),
    ];
    if (config.ytdlpImpersonate) args.push("--impersonate", config.ytdlpImpersonate);
    if (cookieFile) args.push("--cookies", cookieFile);
    else if (useCookies && config.ytdlpCookiesFromBrowser) {
        args.push("--cookies-from-browser", config.ytdlpCookiesFromBrowser);
    }

    if (outputType === "thumbnail" || outputType === "image") {
        args.push("--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg");
    } else {
        args.push("--format", ytDlpFormatSelector(outputType, options.targetBytes, options.maxHeight));
        if (outputType !== "audio") args.push("--merge-output-format", "mp4");
    }
    args.push("--", rawUrl);

    let processError = null;
    try {
        await (options.processRunner ?? runProcess)(resolveYtDlpPath(), args, {
            timeoutMs: config.ytdlpTimeoutMs,
            signal: options.signal,
            onStdoutLine: progressHandler(options),
        });
    } catch (error) {
        if (error instanceof ProcessExecutionError && error.aborted)
            throw Object.assign(new Error("The download was cancelled."), { name: "AbortError" });
        processError = error;
    }

    const artifact = await recoverArtifact(attemptDir, { outputType, maxBytes, signal: options.signal });
    if (artifact) {
        return {
            ...artifact,
            method: "yt-dlp",
            sourceUrl: rawUrl,
            metadata: await readMetadata(attemptDir),
            recoveredFromProcessError: Boolean(processError),
        };
    }
    if (!processError) throw new DownloadMethodError("yt-dlp", "yt-dlp finished without a playable file.");
    const message = cleanError(processError);
    if (/larger than max-filesize|exceeds.*filesize/i.test(message)) {
        throw userError(`The source is larger than ${formatBytes(maxBytes)}.`, "FILE_TOO_LARGE", {
            stopFallback: true,
        });
    }
    throw new DownloadMethodError("yt-dlp", message, { cause: processError });
}
