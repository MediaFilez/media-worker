import fs from "node:fs/promises";
import path from "node:path";
import { describeFile, makeSafeFileName } from "../utils/files.js";
import { getMediaInfo } from "../utils/ffmpeg.js";
import { userError } from "../utils/errors.js";
import { formatBytes } from "../utils/format.js";

const SIDECAR_EXTENSIONS = new Set([".json", ".part", ".ytdl", ".tmp", ".vtt", ".srt", ".ass", ".lrc", ".description", ".txt"]);

async function listFiles(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await listFiles(fullPath)));
        else if (entry.isFile() && !SIDECAR_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(fullPath);
    }
    return files;
}

/**
 * Finds non-empty artifact files and orders them by descending size.
 * @param {string} attemptDir - The directory containing files to inspect.
 * @return {Promise<Array<{filePath: string, sizeBytes: number}>>} The artifact candidates sorted from largest to smallest.
 */
export async function findArtifactCandidates(attemptDir) {
    const candidates = [];
    for (const filePath of await listFiles(attemptDir)) {
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat?.size > 0) candidates.push({ filePath, sizeBytes: stat.size });
    }
    return candidates.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

/**
 * Validate a downloaded artifact and determine its media characteristics.
 * @param {string|Object} candidate - The artifact path or a file descriptor containing `filePath`.
 * @param {Object} [options] - Validation and media-detection options.
 * @param {string} [options.outputType] - Required output type, such as `audio`, `video`, `image`, or `thumbnail`.
 * @param {number} [options.maxBytes] - Maximum permitted file size in bytes.
 * @param {string} [options.preferredName] - Name to use when describing the artifact.
 * @param {AbortSignal} [options.signal] - Signal for cancelling media inspection.
 * @returns {Promise<Object>} File metadata enriched with the resolved media kind, audio-only status, and media information.
 * @throws {Error} If the artifact is empty, too large, unrecognized, lacks playable media, or does not satisfy the requested output type.
 */
export async function validateArtifact(candidate, options = {}) {
    const filePath = typeof candidate === "string" ? candidate : candidate.filePath;
    const file = await describeFile(filePath, options.preferredName || path.basename(filePath), options.outputType || "media");
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (file.sizeBytes <= 0) throw new Error("The downloaded artifact is empty.");
    if (file.sizeBytes > maxBytes) {
        throw userError(
            `The source file is ${formatBytes(file.sizeBytes)}. The maximum allowed download is ${formatBytes(maxBytes)}.`,
            "FILE_TOO_LARGE",
            { stopFallback: true },
        );
    }

    let mediaInfo = null;
    if (file.mediaKind === "video" || file.mediaKind === "audio") {
        mediaInfo = await getMediaInfo(filePath, { signal: options.signal });
        if (!mediaInfo.hasVideo && !mediaInfo.hasAudio) throw new Error("FFprobe found no playable media streams.");
        if (options.outputType === "video" && !mediaInfo.hasVideo) throw new Error("The artifact has no video stream.");
        if (options.outputType === "audio" && !mediaInfo.hasAudio) throw new Error("The artifact has no audio stream.");
    }

    const mediaKind = mediaInfo?.hasVideo ? "video" : mediaInfo?.hasAudio ? "audio" : file.mediaKind;
    if (options.outputType === "video" && mediaKind !== "video") {
        throw new Error(`The artifact contains ${mediaKind} media, not video.`);
    }
    if (options.outputType === "audio" && !mediaInfo?.hasAudio) {
        throw new Error(`The artifact contains ${mediaKind} media, not audio.`);
    }
    if (["image", "thumbnail"].includes(options.outputType) && !["image", "video"].includes(mediaKind)) {
        throw new Error("The artifact cannot produce an image.");
    }
    if (mediaKind === "unknown") throw new Error("The artifact is not a recognized media file.");

    return {
        ...file,
        mediaKind,
        isAudioOnly: Boolean(mediaInfo?.hasAudio && !mediaInfo?.hasVideo),
        mediaInfo,
    };
}

/**
 * Finds and validates the first suitable artifact in an attempt directory.
 * @param {string} attemptDir - The directory containing candidate artifacts.
 * @param {Object} [options] - Validation options.
 * @returns {Promise<Object|null>} The validated artifact, or `null` if no candidate is suitable.
 */
export async function recoverArtifact(attemptDir, options = {}) {
    for (const candidate of await findArtifactCandidates(attemptDir)) {
        try {
            return await validateArtifact(candidate, options);
        } catch (error) {
            if (error?.stopFallback) throw error;
        }
    }
    return null;
}

/**
 * Commits an artifact to the job's completed directory.
 * @param {Object} artifact - The artifact metadata and source file path.
 * @param {string} jobDir - The job directory containing the completed directory.
 * @return {Promise<Object>} The artifact metadata updated with its committed path, filename, and status.
 */
export async function commitArtifact(artifact, jobDir) {
    const completedDir = path.join(jobDir, "completed");
    await fs.mkdir(completedDir, { recursive: true });
    const safeName = makeSafeFileName(artifact.fileName, "media", artifact.extension);
    let destination = path.join(completedDir, safeName);
    if (path.resolve(destination) !== path.resolve(artifact.filePath)) {
        try {
            await fs.rename(artifact.filePath, destination);
        } catch (error) {
            if (error.code !== "EXDEV") throw error;
            await fs.copyFile(artifact.filePath, destination);
            await fs.rm(artifact.filePath, { force: true });
        }
    } else {
        destination = artifact.filePath;
    }
    return { ...artifact, filePath: destination, fileName: path.basename(destination), committed: true };
}
