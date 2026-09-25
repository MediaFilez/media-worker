import fs from "node:fs/promises";
import path from "node:path";
import { describeFile, makeSafeFileName } from "../utils/files.js";
import { formatBytes } from "../utils/format.js";
import { userError } from "../utils/errors.js";
import {
    assertSafeMediaFile,
    compressImage,
    compressVideo,
    extractAudio,
    extractThumbnail,
    getMediaInfo,
    requireFFmpeg,
    runFFmpeg,
} from "../utils/ffmpeg.js";

async function copyImage(input, tempDir, outputName) {
    const outputPath = path.join(tempDir, outputName);
    if (path.resolve(input.filePath) !== path.resolve(outputPath)) await fs.copyFile(input.filePath, outputPath);
    return outputPath;
}

function ensureFits(file, maxOutputBytes, outputType) {
    if (!maxOutputBytes || file.sizeBytes <= maxOutputBytes) return;
    throw userError(
        `The ${outputType} is ${formatBytes(file.sizeBytes)}, above the configured output limit of ${formatBytes(maxOutputBytes)}.`,
        "FILE_TOO_LARGE",
    );
}

/**
 * Converts or size-fits a validated media artifact without knowing how it will be delivered.
 * @param {Object} download - Downloaded media details, including its path, name, type, and size.
 * @param {Object} options - Output format, size limit, temporary directory, compression, status, and cancellation options.
 * @returns {Promise<Object>} Prepared file metadata with an optional processing note.
 * @throws {Error} If the media type is unsupported, the requested format is incompatible, or the file exceeds the size limit without compression enabled.
 */
export async function processMedia(download, options) {
    const { outputType: requestedOutputType, tempDir, maxOutputBytes = null, allowCompression = false, onStatus, signal } = options;
    const format = options.format ?? "original";
    const outputType = requestedOutputType === "auto" ? download.mediaKind : requestedOutputType;
    if (!["video", "audio", "image", "thumbnail"].includes(outputType)) {
        throw userError("The downloaded file type could not be detected as video, audio, or image.", "UNSUPPORTED_MEDIA");
    }
    let outputPath = download.filePath;
    let outputName = download.fileName;
    let note = null;

    if (outputType === "video") {
        if (download.mediaKind !== "video") throw userError("The source is not a video. Choose audio or image output.", "WRONG_MEDIA_TYPE");
        if (maxOutputBytes && download.sizeBytes > maxOutputBytes) {
            if (!allowCompression) {
                throw userError(
                    `The video is ${formatBytes(download.sizeBytes)}, above the ${formatBytes(maxOutputBytes)} output limit.`,
                    "FILE_TOO_LARGE",
                );
            }
            await assertSafeMediaFile(download.filePath, { signal });
            await requireFFmpeg("video fitting");
            const fittingDetail = "Fitting video to the requested output size";
            await onStatus?.({ phase: "processing", detail: fittingDetail });
            outputPath = await compressVideo(download.filePath, tempDir, Math.floor(maxOutputBytes * 0.98), {
                signal,
                onStage: (detail) => onStatus?.({ phase: "processing", detail }),
                onProgress: (progress) => onStatus?.({ phase: "processing", detail: "Compressing video", progress }),
            });
            outputName = makeSafeFileName(`fit-${download.fileName}`, "video", "mp4");
            note = "transcoded to fit the requested size";
        } else if (format === "mp4" && download.extension !== "mp4") {
            await assertSafeMediaFile(download.filePath, { signal });
            await requireFFmpeg("video conversion");
            await onStatus?.({ phase: "processing", detail: "Converting video to MP4" });
            outputPath = path.join(tempDir, "converted-video.mp4");
            try {
                await runFFmpeg(
                    ["-i", download.filePath, "-map", "0:v:0", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", "-y", outputPath],
                    { signal },
                );
            } catch {
                await runFFmpeg(
                    [
                        "-i",
                        download.filePath,
                        "-map",
                        "0:v:0",
                        "-map",
                        "0:a?",
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-c:a",
                        "aac",
                        "-movflags",
                        "+faststart",
                        "-y",
                        outputPath,
                    ],
                    { signal },
                );
            }
            outputName = makeSafeFileName(download.fileName, "video", "mp4").replace(/\.[^.]+$/, ".mp4");
            note = "converted to MP4";
        }
    }

    if (outputType === "audio") {
        const extension = (download.extension || path.extname(download.fileName).slice(1)).toLowerCase();
        const canSendOriginal = download.isAudioOnly || download.mediaKind === "audio";
        const requiresMp3 = format === "mp3";
        if (canSendOriginal && !requiresMp3 && (!maxOutputBytes || download.sizeBytes <= maxOutputBytes)) {
            outputName = makeSafeFileName(download.fileName, "audio", extension || "m4a");
            note = "downloaded as audio";
        } else {
            if (canSendOriginal && !allowCompression) {
                throw userError(
                    `The audio is ${formatBytes(download.sizeBytes)}, above the ${formatBytes(maxOutputBytes)} output limit.`,
                    "FILE_TOO_LARGE",
                );
            }
            await requireFFmpeg(canSendOriginal ? "audio fitting" : "audio extraction");
            await onStatus?.({
                phase: "processing",
                detail: canSendOriginal ? "Fitting audio" : "Extracting audio",
            });
            outputPath = await extractAudio(download.filePath, tempDir, maxOutputBytes ? Math.floor(maxOutputBytes * 0.98) : undefined, {
                signal,
                outputFileName: canSendOriginal ? "fit-audio.mp3" : "audio.mp3",
            });
            outputName = canSendOriginal ? "fit-audio.mp3" : "audio.mp3";
            note = canSendOriginal ? "transcoded to fit the requested size" : "extracted as MP3";
        }
    }

    if (outputType === "thumbnail" || outputType === "image") {
        if (download.mediaKind === "image") {
            const extension = path.extname(download.fileName) || ".jpg";
            outputName = outputType === "thumbnail" ? `thumbnail${extension}` : download.fileName;
            outputPath = await copyImage(download, tempDir, outputName);
            if (format === "jpg" && !["jpg", "jpeg"].includes(download.extension)) {
                await assertSafeMediaFile(download.filePath, { signal });
                await requireFFmpeg("image conversion");
                outputPath = path.join(tempDir, "converted-image.jpg");
                await runFFmpeg(["-i", download.filePath, "-frames:v", "1", "-q:v", "2", "-map_metadata", "-1", "-y", outputPath], { signal });
                outputName = outputType === "thumbnail" ? "thumbnail.jpg" : "image.jpg";
                note = "converted to JPEG";
            }
        } else {
            await assertSafeMediaFile(download.filePath, { signal });
            await requireFFmpeg(`${outputType} extraction`);
            await onStatus?.({ phase: "processing", detail: `Extracting ${outputType}` });
            outputName = outputType === "thumbnail" ? "thumbnail.jpg" : "image.jpg";
            outputPath = await extractThumbnail(download.filePath, tempDir, outputName, { signal });
            note = "extracted from the video";
        }

        const imageSize = (await fs.stat(outputPath)).size;
        if (maxOutputBytes && imageSize > maxOutputBytes) {
            if (!allowCompression) {
                throw userError(`The image is ${formatBytes(imageSize)}, above the ${formatBytes(maxOutputBytes)} output limit.`, "FILE_TOO_LARGE");
            }
            await requireFFmpeg("image fitting");
            await onStatus?.({ phase: "processing", detail: "Fitting image" });
            outputPath = await compressImage(outputPath, tempDir, Math.floor(maxOutputBytes * 0.98), {
                signal,
                onStage: (detail) => onStatus?.({ phase: "processing", detail }),
            });
            outputName = outputType === "thumbnail" ? "thumbnail.jpg" : "fit-image.jpg";
            note = note ? `${note}; compressed to fit the requested size` : "compressed to fit the requested size";
        }
    }

    const file = await describeFile(outputPath, outputName, outputType);
    ensureFits(file, maxOutputBytes, outputType);
    return { ...file, note };
}

/**
 * Retrieves media metadata without propagating metadata lookup errors.
 * @param {string} filePath - The path to the media file.
 * @param {Object} [options] - Options for retrieving media metadata.
 * @returns {Promise<Object|null>} The media metadata, or `null` if retrieval fails.
 */
export async function getSafeMediaInfo(filePath, options = {}) {
    try {
        return await getMediaInfo(filePath, options);
    } catch {
        return null;
    }
}
