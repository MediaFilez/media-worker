import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { config } from "../config.js";
import { formatBytes } from "./format.js";
import { userError } from "./errors.js";
import { log } from "./logger.js";
import { ProcessExecutionError, runProcess } from "./process.js";

const execFileAsync = promisify(execFile);
let ffmpegAvailability = null;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 4096 * 4096;

export function assertSafeMediaDimensions(info) {
    const imagePixels = info.width * info.height;
    if (
        !Number.isSafeInteger(imagePixels) ||
        info.width <= 0 ||
        info.height <= 0 ||
        info.width > MAX_IMAGE_DIMENSION ||
        info.height > MAX_IMAGE_DIMENSION ||
        imagePixels > MAX_IMAGE_PIXELS
    ) {
        throw userError(
            `The media dimensions (${info.width}x${info.height}) are too large to process safely. The limit is ${MAX_IMAGE_DIMENSION}px per side and ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} total pixels.`,
            "IMAGE_DIMENSIONS_TOO_LARGE",
        );
    }
    return info;
}

export async function assertSafeMediaFile(inputPath, options = {}) {
    return assertSafeMediaDimensions(await getMediaInfo(inputPath, options));
}

export function resolveFFmpegPaths() {
    return {
        ffmpeg: config.ffmpegPath || ffmpegStaticPath || "ffmpeg",
        ffprobe: config.ffprobePath || ffprobeInstaller.path || "ffprobe",
    };
}

function missingFfmpegError(binary) {
    return userError(
        `${binary} is not installed on this host. Install FFmpeg so audio conversion, video thumbnails, image extraction, and video fitting can work.`,
        "FFMPEG_MISSING",
        { stopFallback: true },
    );
}

async function runBinary(binary, label, args, options = {}) {
    const timeout = options.timeoutMs ?? config.ffmpegTimeoutMs;
    try {
        const { stdout, stderr } = await execFileAsync(binary, args, {
            timeout,
            signal: options.signal,
            maxBuffer: 20 * 1024 * 1024,
            windowsHide: true,
        });
        return { stdout, stderr };
    } catch (error) {
        if (error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
        if (error.killed || error.signal === "SIGTERM") {
            throw userError(`${label} timed out while processing this file.`, "PROCESS_TIMEOUT");
        }
        if (error.code === "ENOENT") {
            throw missingFfmpegError(label);
        }
        throw new Error(`${label} failed: ${error.stderr || error.message}`);
    }
}

export async function runFFmpeg(args, options = {}) {
    if (!options.onProgress) {
        return await runBinary(resolveFFmpegPaths().ffmpeg, "FFmpeg", ["-hide_banner", ...args], options);
    }

    const progress = {};
    const reportProgress = (line) => {
        const separator = line.indexOf("=");
        if (separator === -1) return;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        progress[key] = value;
        if (key !== "progress") return;

        const processedSeconds = Math.max(0, Number.parseInt(progress.out_time_us || "0", 10) / 1_000_000);
        const durationSeconds = Number(options.durationSeconds) || null;
        const percent = durationSeconds ? Math.min(value === "end" ? 100 : 99.9, (processedSeconds / durationSeconds) * 100) : null;
        options.onProgress({
            percent,
            processedSeconds,
            totalSeconds: durationSeconds,
            speed: progress.speed || null,
        });
    };

    try {
        return await runProcess(resolveFFmpegPaths().ffmpeg, ["-hide_banner", "-nostats", "-progress", "pipe:1", ...args], {
            timeoutMs: options.timeoutMs ?? config.ffmpegTimeoutMs,
            signal: options.signal,
            onStdoutLine: reportProgress,
        });
    } catch (error) {
        if (error instanceof ProcessExecutionError && error.aborted) {
            throw Object.assign(new Error("FFmpeg was cancelled."), { name: "AbortError" });
        }
        if (error instanceof ProcessExecutionError && error.timedOut) {
            throw userError("FFmpeg timed out while processing this file.", "PROCESS_TIMEOUT");
        }
        if (error.cause?.code === "ENOENT") throw missingFfmpegError("FFmpeg");
        throw new Error(`FFmpeg failed: ${error.stderr || error.message}`);
    }
}

async function runFFprobe(args, options = {}) {
    const { stdout } = await runBinary(resolveFFmpegPaths().ffprobe, "FFprobe", ["-v", "quiet", ...args], {
        ...options,
        timeoutMs: 30_000,
    });
    return stdout;
}

export async function getMediaInfo(inputPath, options = {}) {
    const raw = await runFFprobe(["-print_format", "json", "-show_format", "-show_streams", inputPath], options);

    const data = JSON.parse(raw);
    const format = data.format || {};
    const streams = data.streams || [];
    const videoStream = streams.find((stream) => stream.codec_type === "video");
    const audioStream = streams.find((stream) => stream.codec_type === "audio");

    return {
        duration: Number.parseFloat(format.duration || "0"),
        sizeBytes: Number.parseInt(format.size || "0", 10),
        bitrate: Number.parseInt(format.bit_rate || "0", 10),
        hasVideo: Boolean(videoStream),
        hasAudio: Boolean(audioStream),
        width: Number.parseInt(videoStream?.width || "0", 10),
        height: Number.parseInt(videoStream?.height || "0", 10),
        videoBitrate: Number.parseInt(videoStream?.bit_rate || "0", 10),
        audioBitrate: Number.parseInt(audioStream?.bit_rate || "0", 10),
        formatName: format.format_name || "unknown",
    };
}

export async function extractThumbnail(inputPath, outputDir, outputName = "thumbnail.jpg", options = {}) {
    await assertSafeMediaFile(inputPath, options);
    const outputPath = path.join(outputDir, outputName);
    let lastError;

    for (const seek of ["00:00:01", "00:00:00"]) {
        await fs.rm(outputPath, { force: true });
        try {
            await runFFmpeg(["-ss", seek, "-i", inputPath, "-frames:v", "1", "-q:v", "2", "-y", outputPath], options);
            await fs.access(outputPath);
            return outputPath;
        } catch (error) {
            if (error.name === "AbortError" || error.code === "ABORT_ERR" || error.code === "PROCESS_TIMEOUT") {
                throw error;
            }
            lastError = error;
        }
    }

    throw lastError;
}

function audioBitrateForTarget(duration, targetSizeBytes) {
    if (!duration || !targetSizeBytes) return 192;

    const availableBitsPerSecond = Math.floor((targetSizeBytes * 8 * 0.9) / duration);
    const kbps = Math.floor(availableBitsPerSecond / 1000);
    return Math.min(192, Math.max(48, kbps));
}

/**
 * Extracts the audio stream as MP3 using a bitrate derived from the target size.
 * @param {string} inputPath - Path to the source media file.
 * @param {string} outputDir - Directory for the converted audio file.
 * @param {number} targetSizeBytes - Maximum desired output size in bytes.
 * @param {Object} [options={}] - Conversion options, including an optional output file name.
 * @param {string} [options.outputFileName] - Name of the output audio file.
 * @return {Promise<string>} The path to the converted MP3 file.
 */
export async function extractAudio(inputPath, outputDir, targetSizeBytes, options = {}) {
    const info = await getMediaInfo(inputPath, options);
    if (!info.hasAudio) {
        throw userError("The downloaded media does not contain an audio stream.", "NO_AUDIO");
    }

    const kbps = audioBitrateForTarget(info.duration, targetSizeBytes);
    if (targetSizeBytes && kbps <= 48 && info.duration && (48_000 * info.duration) / 8 > targetSizeBytes) {
        throw userError(`The audio is too long to fit inside ${formatBytes(targetSizeBytes)} at usable quality.`, "FILE_TOO_LARGE");
    }

    let outputPath = path.join(outputDir, options.outputFileName || "audio.mp3");
    if (path.resolve(outputPath) === path.resolve(inputPath)) {
        outputPath = path.join(outputDir, "converted-audio.mp3");
    }

    await runFFmpeg(["-i", inputPath, "-vn", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-ar", "44100", "-y", outputPath], options);

    await fs.access(outputPath);
    return outputPath;
}

/**
 * Compresses an image to JPEG until it meets the target file size.
 * @param {string} inputPath - The path to the source image.
 * @param {string} outputDir - The directory for the compressed image.
 * @param {number} targetSizeBytes - The maximum permitted output size in bytes.
 * @param {Object} [options] - Optional processing and progress-reporting options.
 * @return {Promise<string>} The path to the compressed JPEG image.
 */
export async function compressImage(inputPath, outputDir, targetSizeBytes, options = {}) {
    const info = await getMediaInfo(inputPath, options);
    assertSafeMediaDimensions(info);

    const baseName = path.basename(inputPath, path.extname(inputPath));
    let outputPath = path.join(outputDir, `fit-${baseName}.jpg`);
    if (path.resolve(outputPath) === path.resolve(inputPath)) {
        outputPath = path.join(outputDir, `fit-${baseName}-converted.jpg`);
    }
    const attempts = [
        { maxWidth: 4096, quality: 2 },
        { maxWidth: 4096, quality: 5 },
        { maxWidth: 3072, quality: 5 },
        { maxWidth: 2048, quality: 6 },
        { maxWidth: 1600, quality: 7 },
        { maxWidth: 1280, quality: 8 },
        { maxWidth: 960, quality: 10 },
        { maxWidth: 640, quality: 12 },
        { maxWidth: 480, quality: 16 },
    ];

    for (const attempt of attempts) {
        await options.onStage?.(`Compressing image at up to ${attempt.maxWidth}px`);
        await fs.rm(outputPath, { force: true });
        await runFFmpeg(
            [
                "-i",
                inputPath,
                "-frames:v",
                "1",
                "-vf",
                `scale=w=min(iw\\,${attempt.maxWidth}):h=min(ih\\,${attempt.maxWidth}):force_original_aspect_ratio=decrease:force_divisible_by=2`,
                "-q:v",
                String(attempt.quality),
                "-map_metadata",
                "-1",
                "-y",
                outputPath,
            ],
            options,
        );
        const stat = await fs.stat(outputPath);
        if (stat.size <= targetSizeBytes) {
            log.info(`Image fitting produced ${formatBytes(stat.size)} at up to ${attempt.maxWidth}px.`);
            return outputPath;
        }
    }

    const stat = await fs.stat(outputPath);
    await fs.rm(outputPath, { force: true });
    throw userError(
        `The compressed image is still ${formatBytes(stat.size)}, above the output limit of ${formatBytes(targetSizeBytes)}.`,
        "FILE_TOO_LARGE",
    );
}

/**
 * Calculates audio and video bitrates for fitting a video within a target size.
 * @param {Object} info - Video metadata, including duration and audio presence.
 * @param {number} targetSizeBytes - Maximum output size in bytes.
 * @param {number} [scale=0.9] - Fraction of the target size available for media data.
 * @returns {{videoKbps: number, audioKbps: number}} The calculated video and audio bitrates in kilobits per second.
 * @throws {Error} If the video bitrate would be too low for a playable video.
 */
function videoBitratesForTarget(info, targetSizeBytes, scale = 0.9) {
    const availableBitrate = Math.floor((targetSizeBytes * 8 * scale) / info.duration);
    let audioBitrate = 0;
    if (info.hasAudio) {
        audioBitrate = Math.min(96_000, Math.max(24_000, Math.floor(availableBitrate * 0.16)));
    }
    const videoBitrate = availableBitrate - audioBitrate;

    if (videoBitrate < 24_000) {
        throw userError(
            `This video is too long to fit inside ${formatBytes(targetSizeBytes)} as a playable video. Audio or image output will fit more reliably.`,
            "FILE_TOO_LARGE",
        );
    }

    return { videoKbps: Math.floor(videoBitrate / 1000), audioKbps: Math.floor(audioBitrate / 1000) };
}

function maxWidthForBitrate(videoKbps) {
    if (videoKbps < 80) return 320;
    if (videoKbps < 160) return 480;
    if (videoKbps < 350) return 640;
    if (videoKbps < 700) return 854;
    return 1280;
}

async function tryFastFit(label, args, outputPath, targetSizeBytes, options) {
    await fs.rm(outputPath, { force: true });
    try {
        await runFFmpeg([...args, "-y", outputPath], options);
        const stat = await fs.stat(outputPath);
        if (stat.size <= targetSizeBytes) {
            log.info(`${label} fit the video at ${formatBytes(stat.size)}.`);
            return outputPath;
        }
        log.info(`${label} produced ${formatBytes(stat.size)}; a smaller result is still needed.`);
    } catch (error) {
        if (error.name === "AbortError" || error.code === "ABORT_ERR") throw error;
        log.warn(`${label} was not usable: ${error.message}`);
    }
    await fs.rm(outputPath, { force: true });
    return null;
}

async function tryRemux(inputPath, outputDir, baseName, targetSizeBytes, options) {
    const outputPath = path.join(outputDir, `fit-remux-${baseName}.mp4`);
    return await tryFastFit(
        "Lossless remux",
        ["-i", inputPath, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-map_metadata", "-1", "-movflags", "+faststart"],
        outputPath,
        targetSizeBytes,
        options,
    );
}

async function tryAudioFit(inputPath, outputDir, baseName, info, targetSizeBytes, options) {
    if (!info.hasAudio) return null;
    const totalTargetBitrate = Math.floor((targetSizeBytes * 8 * 0.96) / info.duration);
    const estimatedVideoBitrate = info.videoBitrate || Math.max(0, info.bitrate - (info.audioBitrate || 0));
    const audioKbps = Math.min(96, Math.max(24, Math.floor((totalTargetBitrate - estimatedVideoBitrate) / 1000)));
    const outputPath = path.join(outputDir, `fit-audio-${baseName}.mp4`);
    const candidates = [audioKbps, 16];

    for (const candidateKbps of candidates) {
        const args = [
            "-i",
            inputPath,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            `${candidateKbps}k`,
            "-ac",
            candidateKbps < 56 ? "1" : "2",
            "-ar",
            candidateKbps <= 24 ? "32000" : "44100",
            "-map_metadata",
            "-1",
            "-movflags",
            "+faststart",
        ];
        const result = await tryFastFit(`Video-copy/audio fit at ${candidateKbps}k`, args, outputPath, targetSizeBytes, options);
        if (result) return result;
    }

    return null;
}

async function compressAttempt(inputPath, outputPath, info, targetSizeBytes, scale, options) {
    const { videoKbps, audioKbps } = videoBitratesForTarget(info, targetSizeBytes, scale);
    const maxWidth = maxWidthForBitrate(videoKbps);
    const args = [
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-threads",
        String(config.ffmpegThreads),
        "-b:v",
        `${videoKbps}k`,
        "-maxrate",
        `${Math.floor(videoKbps * 1.2)}k`,
        "-bufsize",
        `${Math.floor(videoKbps * 2)}k`,
        "-vf",
        `scale=min(iw\\,${maxWidth}):-2`,
        "-pix_fmt",
        "yuv420p",
    ];

    if (info.hasAudio) {
        args.push("-c:a", "aac", "-b:a", `${audioKbps}k`, "-ac", audioKbps < 56 ? "1" : "2");
    } else {
        args.push("-an");
    }

    args.push("-movflags", "+faststart", "-y", outputPath);

    log.info(`Compressing video to ${videoKbps}k video bitrate.`);
    await runFFmpeg(args, { ...options, durationSeconds: info.duration });
    return await fs.stat(outputPath);
}

function remuxCouldFit(info, targetSizeBytes) {
    return info.sizeBytes > 0 && info.sizeBytes <= targetSizeBytes * 1.05;
}

function audioOnlyFitCouldWork(info, targetSizeBytes) {
    if (!info.hasAudio || !info.videoBitrate || !info.duration) return info.hasAudio;
    const estimatedVideoBytes = (info.videoBitrate * info.duration) / 8;
    return estimatedVideoBytes <= targetSizeBytes * 0.98;
}

export async function compressVideo(inputPath, outputDir, targetSizeBytes, options = {}) {
    const info = await getMediaInfo(inputPath, options);

    if (!info.hasVideo) {
        throw userError("The downloaded media does not contain a video stream.", "NO_VIDEO");
    }

    if (!info.duration || info.duration < 0.5) {
        throw userError("The video duration could not be detected, so it cannot be compressed safely.", "PROCESS_FAILED");
    }

    const baseName = path.basename(inputPath, path.extname(inputPath));
    if (remuxCouldFit(info, targetSizeBytes)) {
        await options.onStage?.("Trying a lossless container fit");
        const remuxed = await tryRemux(inputPath, outputDir, baseName, targetSizeBytes, options);
        if (remuxed) return remuxed;
    } else {
        log.info("Skipping lossless remux because the source is far above the output limit.");
    }

    if (audioOnlyFitCouldWork(info, targetSizeBytes)) {
        await options.onStage?.("Trying a fast audio-only fit");
        const audioFit = await tryAudioFit(inputPath, outputDir, baseName, info, targetSizeBytes, options);
        if (audioFit) return audioFit;
    } else {
        log.info("Skipping audio-only fitting because the copied video stream cannot fit the output limit.");
    }

    const outputPath = path.join(outputDir, `fit-${baseName}.mp4`);
    await options.onStage?.("Compressing video to the requested size");
    let stat = await compressAttempt(inputPath, outputPath, info, targetSizeBytes, 0.92, options);

    if (stat.size > targetSizeBytes) {
        stat = await compressAttempt(inputPath, outputPath, info, targetSizeBytes, 0.8, options);
    }

    if (stat.size > targetSizeBytes) {
        throw userError(
            `The compressed video is still ${formatBytes(stat.size)}, above the output limit of ${formatBytes(targetSizeBytes)}.`,
            "FILE_TOO_LARGE",
        );
    }

    return outputPath;
}

export async function checkFFmpeg() {
    if (ffmpegAvailability !== null) return ffmpegAvailability;

    try {
        const binaries = resolveFFmpegPaths();
        await Promise.all([
            execFileAsync(binaries.ffmpeg, ["-version"], { timeout: 5000, windowsHide: true }),
            execFileAsync(binaries.ffprobe, ["-version"], { timeout: 5000, windowsHide: true }),
        ]);
        ffmpegAvailability = true;
        return ffmpegAvailability;
    } catch {
        ffmpegAvailability = false;
        return ffmpegAvailability;
    }
}

export async function requireFFmpeg(featureName) {
    if (await checkFFmpeg()) return;
    throw userError(
        `FFmpeg is unavailable, so ${featureName} cannot run. Reinstall dependencies or set FFMPEG_PATH and FFPROBE_PATH.`,
        "FFMPEG_MISSING",
        { stopFallback: true },
    );
}
