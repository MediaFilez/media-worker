import { GB, MB } from "../config.js";

export const FILE_LIMITS = {
    DEFAULT_OUTPUT: 5 * GB,
    MAX_DOWNLOAD: 100 * GB,
};

export const OUTPUT_TYPES = new Set(["auto", "video", "image", "thumbnail", "audio"]);

export const SUPPORTED_VIDEO = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v", ".3gp"]);
export const SUPPORTED_IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".avif"]);
export const SUPPORTED_AUDIO = new Set([".mp3", ".ogg", ".opus", ".wav", ".flac", ".m4a", ".aac", ".wma"]);

export const SUPPORTED_ALL = new Set([...SUPPORTED_VIDEO, ...SUPPORTED_IMAGE, ...SUPPORTED_AUDIO]);
