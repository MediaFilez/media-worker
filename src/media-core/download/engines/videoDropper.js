import https from "node:https";
import { createCipheriv } from "node:crypto";
import { DownloadMethodError } from "../../utils/errors.js";
import { publicDnsLookup } from "../../utils/security.js";
import { downloadDirectHttp } from "./directHttp.js";
import { readBoundedJsonResponse } from "./cobalt.js";

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
    const entries = Array.isArray(data?.video) ? data.video : [];
    const candidates = entries
        .map((entry) => {
            if (!entry || typeof entry !== "object") return null;
            if (options.outputType === "thumbnail") return entry.thumbnail ?? entry.image ?? entry.video;
            if (options.outputType === "image") return entry.image ?? entry.video ?? entry.thumbnail;
            return entry.video ?? entry.image;
        })
        .filter((value) => typeof value === "string" && value.length > 0)
        .slice(0, 20);
    if (!candidates.length) throw new DownloadMethodError(METHOD, "VideoDropper returned no downloadable media.");

    for (const candidate of candidates) {
        try {
            return await downloadDirectHttp(candidate, attemptDir, {
                ...options,
                methodLabel: METHOD,
                referer: "https://www.instagram.com/",
            });
        } catch (error) {
            options.signal?.throwIfAborted();
            if (error?.stopFallback) throw error;
        }
    }
    throw new DownloadMethodError(METHOD, "VideoDropper media could not be downloaded.");
}
