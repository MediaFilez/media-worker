import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { DownloadMethodError, UserFacingError, userError } from "../utils/errors.js";
import { assertPublicHttpUrl } from "../utils/security.js";
import { log } from "../utils/logger.js";
import { classifySource, planEngines } from "./planner.js";
import { commitArtifact, recoverArtifact, validateArtifact } from "./artifact.js";
import { downloadDirectHttp } from "./engines/directHttp.js";
import { downloadWithYtDlp } from "./engines/ytDlp.js";
import { downloadWithCobalt } from "./engines/cobalt.js";
import { downloadWithYouTubeJs } from "./engines/youtubeJs.js";
import { downloadWithGalleryDl } from "./engines/galleryDl.js";
import { downloadFromPageMetadata } from "./engines/pageMetadata.js";
import { downloadWithInstagramProxy } from "./engines/instagramProxy.js";
import { downloadFromRedditEmbed } from "./engines/redditEmbed.js";
import { downloadWithRedditProxy } from "./engines/redditProxy.js";

const DEFAULT_ENGINES = new Map([
    ["direct-http", downloadDirectHttp],
    ["yt-dlp", downloadWithYtDlp],
    ["cobalt", downloadWithCobalt],
    ["youtube-js", downloadWithYouTubeJs],
    ["gallery-dl", downloadWithGalleryDl],
    ["page-metadata", downloadFromPageMetadata],
    ["instagram-proxy", downloadWithInstagramProxy],
    ["reddit-embed", downloadFromRedditEmbed],
    ["reddit-proxy", downloadWithRedditProxy],
]);

function compactEngineError(message) {
    const detail = String(message || "Unknown engine failure")
        .replace(/\s+/g, " ")
        .trim();
    if (/you(?:'|’)ve been blocked by network security/i.test(detail)) {
        return "The source blocked this server's network address.";
    }
    return detail.length > 800 ? `${detail.slice(0, 797)}...` : detail;
}

function abortError() {
    return userError("The job timed out before the download finished. Try a smaller file or a faster source.", "JOB_TIMEOUT", { stopFallback: true });
}

function publicFailure(rawUrl, attempts, outputType) {
    const messages = attempts.map((attempt) => attempt.error).join(" ");
    const engines = [...new Set(attempts.map((attempt) => attempt.engine))].join(", ");
    const source = classifySource(rawUrl);
    if (attempts.length === 0) {
        return "No download engine is enabled for this URL. Check DISABLED_ENGINES and engine configuration.";
    }
    if (/FFmpeg|FFprobe/i.test(messages) && /not installed|unavailable|ENOENT/i.test(messages)) {
        return "FFmpeg or FFprobe is unavailable. Reinstall dependencies or configure FFMPEG_PATH and FFPROBE_PATH.";
    }
    if (/gallery-dl is unavailable/i.test(messages) && attempts.length === 1) {
        return "gallery-dl is unavailable. Run pnpm run tools:install, set GALLERY_DL_PATH, or use Docker.";
    }
    if (outputType !== "auto" && /contains image media, not video|returned image media/i.test(messages)) {
        return "The source is an image. Choose image output and try again.";
    }
    if (source.instagram && /account authentication|cookies|login required/i.test(messages)) {
        return "This Instagram post needs an authenticated session. Export fresh browser cookies with an Instagram session to MEDIA_COOKIES_FILE, then try again.";
    }
    if (/HTTP (?:Error )?403|forbidden|blocked this server's network address/i.test(messages)) {
        return "This source blocked automated access (HTTP 403), and no enabled engine could extract its media. Try a direct media URL or another source.";
    }
    if (/unsupported url|no suitable extractor/i.test(messages)) {
        return "This site or URL is not supported by the enabled download engines.";
    }
    if (/rate.?limit|too many requests|HTTP 429/i.test(messages)) {
        return "The source or a configured download service is rate-limiting requests. Try again later.";
    }
    const outputLabel = outputType === "auto" ? "media" : outputType;
    return `No playable ${outputLabel} came back after trying: ${engines}. The post may be unavailable, expired, or unsupported.`;
}

/**
 * Downloads media from a public HTTP URL using the configured engine fallback plan.
 * @param {string} rawUrl - The media URL to download.
 * @param {string} jobDir - Directory where the downloaded artifact is committed.
 * @param {Object} [options] - Download settings, including output type, size limit, engine plan, cancellation signal, and status callback.
 * @return {Promise<Object>} The committed artifact and download metadata, including the selected method, attempt history, and recovery status.
 * @throws {Error} If the URL is invalid, the operation is cancelled, or all download engines fail.
 */
export async function downloadMedia(rawUrl, jobDir, options = {}) {
    await assertPublicHttpUrl(rawUrl);
    const outputType = options.outputType ?? "video";
    const maxBytes = options.maxBytes ?? config.maxDownloadBytes;
    const engineRegistry = options.engines ?? DEFAULT_ENGINES;
    const plan = options.plan ?? planEngines(rawUrl, outputType);
    const attempts = [];
    let silentFallback = null;

    async function commitResult(artifact, method, metadata, recovered) {
        return {
            ...(await commitArtifact(artifact, jobDir)),
            method,
            metadata,
            attempts,
            recovered,
        };
    }

    async function selectResult(artifact, method, metadata, recovered, index) {
        if (silentFallback) {
            if (artifact.mediaKind !== "video" || !artifact.mediaInfo?.hasAudio) return null;
        } else if (
            ["auto", "video"].includes(outputType) &&
            artifact.mediaKind === "video" &&
            artifact.mediaInfo?.hasAudio === false &&
            plan.indexOf("yt-dlp", index + 1) !== -1 &&
            engineRegistry.has("yt-dlp")
        ) {
            silentFallback = { artifact, method, metadata, recovered };
            log.info(`Trying yt-dlp for an audio-bearing version of the ${method} video.`);
            return null;
        }
        return await commitResult(artifact, method, metadata, recovered);
    }

    for (const [index, engineName] of plan.entries()) {
        if (options.signal?.aborted) throw abortError();
        if (silentFallback && engineName !== "yt-dlp") continue;
        const engine = engineRegistry.get(engineName);
        if (!engine) continue;
        const attemptDir = path.join(jobDir, `attempt-${String(index + 1).padStart(2, "0")}-${engineName}`);
        await fs.mkdir(attemptDir, { recursive: true });
        const startedAt = performance.now();
        await options.onStatus?.({
            phase: "resolving",
            engine: engineName,
            attempt: index + 1,
            totalAttempts: plan.length,
        });

        try {
            const candidate = await engine(rawUrl, attemptDir, {
                ...options,
                maxBytes,
                outputType,
                onProgress: (progress) => options.onStatus?.({ phase: "downloading", engine: engineName, progress }),
            });
            const validated = await validateArtifact(candidate, {
                outputType,
                maxBytes,
                preferredName: candidate.fileName,
                signal: options.signal,
            });
            const result = await selectResult(
                { ...candidate, ...validated },
                candidate.method || engineName,
                candidate.metadata ?? null,
                Boolean(candidate.recoveredFromProcessError),
                index,
            );
            if (result) return result;
        } catch (error) {
            if (options.signal?.aborted) throw abortError();
            if (error instanceof UserFacingError && error.stopFallback) {
                if (!silentFallback) throw error;
                attempts.push({
                    engine: engineName,
                    error: compactEngineError(error.message),
                    elapsedMs: performance.now() - startedAt,
                });
                continue;
            }

            const recovered = await recoverArtifact(attemptDir, { outputType, maxBytes, signal: options.signal });
            if (recovered) {
                const result = await selectResult(recovered, engineName, null, true, index);
                if (result) {
                    log.warn(`${engineName} failed after producing a valid artifact; committing the artifact and stopping fallback.`);
                    return result;
                }
                continue;
            }

            const detail = compactEngineError(error instanceof DownloadMethodError ? error.publicMessage : error.message);
            attempts.push({ engine: engineName, error: detail, elapsedMs: performance.now() - startedAt });
            log.warn(`${engineName} failed: ${detail}`);
            await fs.rm(attemptDir, { recursive: true, force: true });
        }
    }

    if (options.signal?.aborted) throw abortError();
    if (silentFallback) {
        log.info("No audio-bearing alternative was found; keeping the original silent video.");
        return await commitResult(silentFallback.artifact, silentFallback.method, silentFallback.metadata, silentFallback.recovered);
    }

    const error = userError(publicFailure(rawUrl, attempts, outputType), "DOWNLOAD_FAILED");
    error.attempts = attempts;
    throw error;
}

export { DEFAULT_ENGINES };
