import fs from "node:fs/promises";
import path from "node:path";
import sanitizeFilename from "sanitize-filename";
import { fileTypeFromFile } from "file-type";
import { SUPPORTED_AUDIO, SUPPORTED_IMAGE, SUPPORTED_VIDEO } from "./constants.js";

const MIME_EXTENSIONS = new Map([
    ["video/mp4", "mp4"],
    ["video/webm", "webm"],
    ["video/quicktime", "mov"],
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/aac", "aac"],
    ["audio/ogg", "ogg"],
    ["audio/opus", "opus"],
    ["audio/wav", "wav"],
]);

export function extensionFromMime(mime) {
    if (!mime) return null;
    return MIME_EXTENSIONS.get(mime.toLowerCase()) ?? null;
}

export function inferKind({ mime, extension }) {
    const normalizedExtension = extension ? `.${extension.replace(/^\./, "").toLowerCase()}` : "";
    const normalizedMime = mime?.toLowerCase() ?? "";

    if (normalizedMime.startsWith("video/") || SUPPORTED_VIDEO.has(normalizedExtension)) return "video";
    if (normalizedMime.startsWith("image/") || SUPPORTED_IMAGE.has(normalizedExtension)) return "image";
    if (normalizedMime.startsWith("audio/") || SUPPORTED_AUDIO.has(normalizedExtension)) return "audio";
    return "unknown";
}

export function makeSafeFileName(inputName, fallbackName, extension) {
    const fallback = fallbackName || "media";
    const rawName = sanitizeFilename(inputName || fallback) || fallback;
    const currentExtension = path.extname(rawName);
    const base = sanitizeFilename(path.basename(rawName, currentExtension)).slice(0, 140) || fallback;
    const finalExtension = (currentExtension || (extension ? `.${extension.replace(/^\./, "")}` : "")).toLowerCase();
    return `${base}${finalExtension}`;
}

export async function describeFile(filePath, preferredName, fallbackName = "media", fallbackMime = null) {
    const stat = await fs.stat(filePath);
    const detected = await fileTypeFromFile(filePath).catch(() => null);
    const urlExtension = path
        .extname(preferredName || "")
        .replace(/^\./, "")
        .toLowerCase();
    const extension = detected?.ext || urlExtension || extensionFromMime(fallbackMime) || null;
    const mime = detected?.mime || fallbackMime || null;
    const correctedName =
        detected?.ext && urlExtension && detected.ext !== urlExtension
            ? `${path.basename(preferredName, path.extname(preferredName))}.${detected.ext}`
            : preferredName;

    return {
        filePath,
        fileName: makeSafeFileName(correctedName, fallbackName, extension),
        sizeBytes: stat.size,
        mime,
        extension,
        mediaKind: inferKind({ mime, extension }),
    };
}
