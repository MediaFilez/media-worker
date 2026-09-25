export const outputTypes = ["auto", "video", "audio", "image", "thumbnail"] as const;
export type OutputType = (typeof outputTypes)[number];

export const qualityVariants = ["best", "1080p", "720p", "480p", "360p", "audio-only"] as const;
export type QualityVariant = (typeof qualityVariants)[number];

export type MediaKind = "video" | "audio" | "image" | "unknown";

export interface ProgressUpdate {
    phase: "queued" | "resolving" | "downloading" | "processing" | "storing" | "completed" | "retrying";
    detail?: string;
    engine?: string;
    attempt?: number;
    totalAttempts?: number;
    progress?: {
        downloadedBytes?: number;
        totalBytes?: number | null;
        percent?: number | null;
        processedSeconds?: number;
        totalSeconds?: number | null;
        speed?: string | null;
    };
}

export interface MediaArtifact {
    filePath: string;
    fileName: string;
    sizeBytes: number;
    mime: string | null;
    extension: string | null;
    mediaKind: MediaKind;
    mediaInfo?: MediaInfo | null;
    method?: string;
    metadata?: Record<string, unknown> | null;
    attempts?: EngineAttempt[];
    recovered?: boolean;
    note?: string | null;
}

export interface MediaInfo {
    duration: number;
    sizeBytes: number;
    bitrate: number;
    hasVideo: boolean;
    hasAudio: boolean;
    width: number;
    height: number;
    videoBitrate: number;
    audioBitrate: number;
    formatName: string;
}

export interface EngineAttempt {
    engine: string;
    error: string;
    elapsedMs: number;
}

export interface DownloadOptions {
    outputType?: OutputType;
    quality?: QualityVariant;
    maxBytes?: number;
    signal?: AbortSignal;
    onProgress?: (update: ProgressUpdate) => void | Promise<void>;
}

export interface ProcessOptions {
    outputType?: OutputType;
    format?: "original" | "mp4" | "mp3" | "jpg";
    maxOutputBytes?: number;
    allowCompression?: boolean;
    tempDir: string;
    signal?: AbortSignal;
    onProgress?: (update: ProgressUpdate) => void | Promise<void>;
}
