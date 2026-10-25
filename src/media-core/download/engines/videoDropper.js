import https from "node:https";
import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv } from "node:crypto";
import { DownloadMethodError } from "../../utils/errors.js";
import { publicDnsLookup } from "../../utils/security.js";
import { downloadDirectHttp } from "./directHttp.js";
import { readBoundedJsonResponse } from "./cobalt.js";
import { MAX_COLLECTION_ITEMS, mediaCollection, collectionFailure } from "../collection.js";
import { userError } from "../../utils/errors.js";

const METHOD = "videodropper";
const ENDPOINT = "https://api.videodropper.app/allinone";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function requestVideoDropper(headers, signal) {
    return new Promise((resolve, reject) => {
        const request = https.get(ENDPOINT, { headers, signal, lookup: publicDnsLookup }, resolve);
        request.once("error", reject);
    });
}

export async function downloadWithVideoDropper(rawUrl, attemptDir, options = {}) {
    const source = new URL(rawUrl.trim());
    if (
        !["https:", "http:"].includes(source.protocol) ||
        source.username ||
        source.password ||
        !(source.hostname === "instagram.com" || source.hostname.endsWith(".instagram.com"))
    )
        throw new DownloadMethodError(METHOD, "VideoDropper only accepts Instagram URLs.");

    options.signal?.throwIfAborted();
    const cipher = createCipheriv("aes-128-ecb", Buffer.from("qwertyuioplkjhgf", "utf8"), null);
    const encryptedUrl = cipher.update(rawUrl.trim(), "utf8", "hex") + cipher.final("hex");
    const timeout = AbortSignal.timeout(options.videoDropperTimeoutMs ?? 20_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let data;
    try {
        const response = await (options.requestVideoDropper ?? requestVideoDropper)(
            {
                accept: "*/*",
                "accept-language": "ar,ar-AE;q=0.9,en-US;q=0.8,en;q=0.7",
                url: encryptedUrl,
                referer: "https://videodropper.app/",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            },
            signal,
        );
        const status = response.statusCode ?? response.status;
        if (status < 200 || status >= 300) {
            response.destroy?.();
            await response.body?.cancel();
            throw new DownloadMethodError(METHOD, `VideoDropper returned HTTP ${status}.`);
        }
        data = await readBoundedJsonResponse(response, MAX_RESPONSE_BYTES, METHOD);
    } catch (error) {
        options.signal?.throwIfAborted();
        if (error?.stopFallback || error instanceof DownloadMethodError) throw error;
        throw new DownloadMethodError(METHOD, timeout.aborted ? "VideoDropper timed out." : "VideoDropper returned an invalid response.", {
            cause: error,
        });
    }
    options.signal?.throwIfAborted();
    const entries = data?.video ?? [];
    if (!Array.isArray(entries)) throw collectionFailure(new DownloadMethodError(METHOD, "VideoDropper returned invalid video media."));
    const videoCandidates = entries.map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        if (options.outputType === "thumbnail") return entry.thumbnail ?? entry.image ?? entry.video;
        if (options.outputType === "image") return entry.image ?? entry.video ?? entry.thumbnail;
        return entry.video ?? entry.image;
    });
    if (videoCandidates.some((value) => typeof value !== "string" || !value)) {
        throw collectionFailure(new DownloadMethodError(METHOD, "VideoDropper returned invalid video media."));
    }
    const images = ["video", "audio"].includes(options.outputType) ? [] : (data?.image ?? []);
    if (!Array.isArray(images) || images.some((value) => typeof value !== "string" || !value)) {
        throw collectionFailure(new DownloadMethodError(METHOD, "VideoDropper returned invalid image media."));
    }
    const candidates = [...new Set([...videoCandidates, ...images])];
    if (!candidates.length) throw new DownloadMethodError(METHOD, "VideoDropper returned no downloadable media.");
    if (candidates.length > MAX_COLLECTION_ITEMS) {
        throw userError(`The post exceeds the ${MAX_COLLECTION_ITEMS}-file limit.`, "COLLECTION_TOO_LARGE", { stopFallback: true });
    }
    options.onCollection?.(candidates.length);
    const items = [];
    let totalBytes = 0;
    for (const [index, candidate] of candidates.entries()) {
        const destination = path.join(attemptDir, `item-${String(index + 1).padStart(3, "0")}`);
        await fs.mkdir(destination, { recursive: true });
        const remaining = (options.maxBytes ?? Number.MAX_SAFE_INTEGER) - totalBytes;
        if (remaining <= 0) throw userError("The post exceeds the aggregate download size limit.", "FILE_TOO_LARGE", { stopFallback: true });
        try {
            const item = await downloadDirectHttp(candidate, destination, {
                ...options,
                maxBytes: remaining,
                methodLabel: METHOD,
                referer: "https://www.instagram.com/",
            });
            totalBytes += item.sizeBytes;
            items.push(item);
        } catch (error) {
            options.signal?.throwIfAborted();
            if (error?.stopFallback) throw error;
            throw collectionFailure(new DownloadMethodError(METHOD, "VideoDropper could not download the complete post.", { cause: error }));
        }
    }
    return mediaCollection(items);
}
