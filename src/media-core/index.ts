import { planEngines } from "./download/planner.js";
import { downloadMedia as runDownload } from "./download/orchestrator.js";
import { processMedia as runProcessing } from "./media/processor.js";
import { describeFile } from "./utils/files.js";
import { getMediaInfo } from "./utils/ffmpeg.js";
import type { DownloadOptions, MediaArtifact, MediaInfo, OutputType, ProcessOptions } from "./types.js";

const qualityHeights = {
    best: undefined,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
    "audio-only": undefined,
} as const;

export interface ResolvedMedia {
    url: string;
    outputType: OutputType;
    engines: string[];
}

export interface MediaCore {
    resolveMedia(url: string, options?: Pick<DownloadOptions, "outputType" | "quality">): Promise<ResolvedMedia>;
    downloadMedia(url: string, destinationDir: string, options?: DownloadOptions): Promise<MediaArtifact>;
    inspectMedia(filePath: string, preferredName?: string): Promise<MediaArtifact & { mediaInfo: MediaInfo | null }>;
    processMedia(artifact: MediaArtifact, options: ProcessOptions): Promise<MediaArtifact>;
}

export function createMediaCore(): MediaCore {
    return {
        async resolveMedia(url, options = {}) {
            const outputType = options.quality === "audio-only" ? "audio" : (options.outputType ?? "auto");
            return { url, outputType, engines: planEngines(url, outputType) };
        },

        async downloadMedia(url, destinationDir, options = {}) {
            const outputType = options.quality === "audio-only" ? "audio" : (options.outputType ?? "auto");
            const maxHeight = options.quality ? qualityHeights[options.quality] : undefined;
            return (await runDownload(url, destinationDir, {
                outputType,
                maxBytes: options.maxBytes,
                maxHeight,
                signal: options.signal,
                onStatus: options.onProgress,
            })) as MediaArtifact;
        },

        async inspectMedia(filePath, preferredName) {
            const artifact = (await describeFile(filePath, preferredName)) as MediaArtifact;
            let mediaInfo: MediaInfo | null = null;
            if (artifact.mediaKind === "video" || artifact.mediaKind === "audio") {
                mediaInfo = (await getMediaInfo(filePath).catch(() => null)) as MediaInfo | null;
            }
            return { ...artifact, mediaInfo };
        },

        async processMedia(artifact, options) {
            return (await runProcessing(artifact, {
                ...options,
                onStatus: options.onProgress,
            })) as MediaArtifact;
        },
    };
}

export * from "./types.js";
