import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { config } from "../../config.js";
import { DownloadMethodError, userError } from "../../utils/errors.js";
import { publicDnsLookup } from "../../utils/security.js";
import { validateArtifact } from "../artifact.js";
import { collectionFailure, MAX_COLLECTION_ITEMS, validateMediaCollection } from "../collection.js";
import { readBoundedJsonResponse } from "./cobalt.js";
import { downloadDirectHttp } from "./directHttp.js";

const METHOD = "grabfy";
const ENDPOINT = "https://api.grabfy.com/api/resolve";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);

function requestGrabfy({ body, headers }, signal) {
    return new Promise((resolve, reject) => {
        const request = https.request(
            ENDPOINT,
            {
                method: "POST",
                headers,
                signal,
                lookup: publicDnsLookup,
            },
            resolve,
        );
        request.once("error", reject);
        request.end(body);
    });
}

function sourceUrl(rawUrl) {
    const source = new URL(rawUrl.trim());

    if (
        !INSTAGRAM_HOSTS.has(source.hostname) ||
        !["https:", "http:"].includes(source.protocol) ||
        source.username ||
        source.password ||
        source.port ||
        !/^\/(?:p|reels?|tv)\/[A-Za-z0-9_-]+\/?$/.test(source.pathname)
    ) {
        throw new DownloadMethodError(METHOD, "Grabfy accepts Instagram post and Reel URLs only.");
    }

    return new URL(`https://www.instagram.com${source.pathname.replace(/\/$/, "")}/`);
}

export async function downloadWithGrabfy(rawUrl, attemptDir, options = {}) {
    if (!config.grabfyEnabled) throw new DownloadMethodError(METHOD, "Grabfy is disabled by the operator.");

    options.signal?.throwIfAborted();
    const source = sourceUrl(rawUrl);
    const body = JSON.stringify({ url: source.href });
    const timeout = AbortSignal.timeout(options.grabfyTimeoutMs ?? config.grabfyTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let data;

    try {
        const response = await (options.requestGrabfy ?? requestGrabfy)(
            {
                body,
                headers: {
                    accept: "application/json",
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                    "user-agent": config.userAgent,
                    referer: "https://grabfy.com/",
                },
            },
            signal,
        );
        const status = response.statusCode ?? response.status;

        if (status < 200 || status >= 300) {
            response.destroy?.();
            await response.body?.cancel();

            throw new DownloadMethodError(METHOD, `Grabfy returned HTTP ${status}.`);
        }

        data = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, METHOD);
    } catch (error) {
        options.signal?.throwIfAborted();

        if (error?.stopFallback || error instanceof DownloadMethodError) throw error;

        throw new DownloadMethodError(METHOD, timeout.aborted ? "Grabfy resolution timed out." : "Grabfy returned an invalid response.");
    }

    options.signal?.throwIfAborted();
    const entries = data?.items;

    if (
        data?.shortcode !== source.pathname.split("/")[2] ||
        !Array.isArray(entries) ||
        !entries.length ||
        entries.some((item) => !item || !["image", "video"].includes(item.type) || typeof item.download !== "string" || !item.download)
    ) {
        if (data?.shortcode === source.pathname.split("/")[2] && Array.isArray(entries)) options.onCollection?.(entries.length);

        throw collectionFailure(new DownloadMethodError(METHOD, "Grabfy returned invalid post media."));
    }

    if (entries.length > MAX_COLLECTION_ITEMS) {
        throw userError(`The post exceeds the ${MAX_COLLECTION_ITEMS}-file limit.`, "COLLECTION_TOO_LARGE", { stopFallback: true });
    }

    const selected = ["video", "audio"].includes(options.outputType) ? entries.filter((item) => item.type === "video") : entries;

    if (!selected.length) throw new DownloadMethodError(METHOD, "The post has no media matching the requested output type.");

    const items = [];
    let totalBytes = 0;

    try {
        for (const [index, entry] of selected.entries()) {
            options.signal?.throwIfAborted();
            const remaining = (options.maxBytes ?? config.maxDownloadBytes) - totalBytes;

            if (remaining <= 0) throw userError("The post exceeds the aggregate download size limit.", "FILE_TOO_LARGE", { stopFallback: true });

            const destination = path.join(attemptDir, `item-${String(index + 1).padStart(3, "0")}`);
            await fs.mkdir(destination, { recursive: true });
            const candidate = options.outputType === "thumbnail" ? (entry.preview ?? entry.download) : entry.download;
            const item = await downloadDirectHttp(candidate, destination, {
                ...options,
                maxBytes: remaining,
                methodLabel: METHOD,
                referer: "https://grabfy.com/",
                trustedHosts: [],
                trustedOrigins: [],
            });
            const validated = await validateArtifact(item, { outputType: "auto", maxBytes: remaining, signal: options.signal });
            const expectedKind = options.outputType === "thumbnail" && entry.preview ? "image" : entry.type;

            if (validated.mediaKind !== expectedKind) throw new DownloadMethodError(METHOD, "Grabfy returned a mismatched media type.");

            totalBytes += validated.sizeBytes;
            items.push({ ...item, ...validated });
        }

        const result = await validateMediaCollection(items, { ...options, maxBytes: options.maxBytes ?? config.maxDownloadBytes });
        options.onCollection?.(result.items?.length ?? 1);

        return {
            ...result,
            metadata: { title: typeof data.title === "string" ? data.title.slice(0, 500) : null, sourceUrl: source.href, extractor: "Grabfy" },
        };
    } catch (error) {
        options.onCollection?.(selected.length);
        options.signal?.throwIfAborted();

        if (error?.stopFallback) throw error;

        throw collectionFailure(new DownloadMethodError(METHOD, "Grabfy could not download the complete requested media."));
    }
}
