import fs from "node:fs/promises";
import { config } from "../../config.js";
import { DownloadMethodError } from "../../utils/errors.js";
import { decodeHtmlEntities } from "../../utils/htmlEntities.js";
import { downloadDirectHttp, openPublicHttpResponse } from "./directHttp.js";

function attributes(tag) {
    const result = new Map();
    const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const match of tag.matchAll(pattern)) {
        result.set(match[1].toLowerCase(), decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    }
    return result;
}

function addValue(values, key, value) {
    if (!key || !value) return;
    const normalized = key.toLowerCase();
    const current = values.get(normalized) ?? [];
    current.push(value.trim());
    values.set(normalized, current);
}

function addUrl(candidates, value, baseUrl) {
    if (!value) return;
    try {
        const url = new URL(value, baseUrl);
        if (["http:", "https:"].includes(url.protocol) && url.href !== baseUrl.href) candidates.push(url.href);
    } catch {
        // Ignore malformed metadata and continue with the remaining candidates.
    }
}

/**
 * Extracts HTTP(S) URLs embedded in the base URL's query parameters.
 * @param {URL} baseUrl - The URL whose query-parameter values are inspected.
 * @return {string[]} Distinct valid HTTP(S) URLs found in the query parameters.
 */
function wrappedUrlCandidates(baseUrl) {
    const candidates = [];
    for (const value of baseUrl.searchParams.values()) {
        let decoded = value;
        for (let pass = 0; pass < 2; pass += 1) {
            if (/^https?:\/\//i.test(decoded)) addUrl(candidates, decoded, baseUrl);
            try {
                const next = decodeURIComponent(decoded);
                if (next === decoded) break;
                decoded = next;
            } catch {
                break;
            }
        }
    }
    return candidates;
}

/**
 * Extracts media URLs from JSON-LD scripts in an HTML document.
 * @param {string} html - The HTML document to inspect.
 * @param {string} baseUrl - The URL used to resolve extracted URLs.
 * @param {string} outputType - The requested media type used to select JSON-LD fields.
 * @return {string[]} Distinct HTTP(S) media URLs found in the document.
 */
function jsonLdCandidates(html, baseUrl, outputType) {
    const acceptedKeys =
        {
            auto: new Set(["contenturl", "embedurl", "thumbnailurl"]),
            video: new Set(["contenturl", "embedurl"]),
            audio: new Set(["contenturl"]),
            image: new Set(["contenturl", "thumbnailurl"]),
            thumbnail: new Set(["contenturl", "thumbnailurl"]),
        }[outputType] ?? new Set();
    const candidates = [];
    let visitedValues = 0;

    function visit(value, key = "", depth = 0) {
        visitedValues += 1;
        if (depth > 16 || visitedValues > 2_000 || candidates.length >= 12) return;
        if (typeof value === "string") {
            if (acceptedKeys.has(key.toLowerCase())) addUrl(candidates, value, baseUrl);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) visit(item, key, depth + 1);
            return;
        }
        if (!value || typeof value !== "object") return;
        for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey, depth + 1);
    }

    for (const match of html.matchAll(
        /<script\b[^>]*type\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi,
    )) {
        try {
            visit(JSON.parse(decodeHtmlEntities(match[1]).trim()));
        } catch {
            continue;
        }
    }
    return candidates;
}

export function extractPageMetadata(html, baseUrl, outputType) {
    const values = new Map();
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = attributes(match[0]);
        addValue(values, attrs.get("property") || attrs.get("name") || attrs.get("itemprop"), attrs.get("content"));
    }

    const inlineMedia = [];
    for (const match of html.matchAll(/<(?:video|audio|source)\b[^>]*>/gi)) {
        const src = attributes(match[0]).get("src");
        if (src) inlineMedia.push(src);
    }

    const keysByType = {
        video: ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"],
        audio: ["og:audio:secure_url", "og:audio:url", "og:audio"],
        image: ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"],
        thumbnail: ["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"],
    };
    const selectedTypes = outputType === "auto" ? ["video", "audio", "image"] : [outputType];
    const keys = selectedTypes.flatMap((type) => keysByType[type] ?? []);

    const rawCandidates = [...keys.flatMap((key) => values.get(key) ?? [])];
    if (["auto", "video", "audio"].includes(outputType)) rawCandidates.push(...inlineMedia);

    const candidates = [...wrappedUrlCandidates(baseUrl), ...jsonLdCandidates(html, baseUrl, outputType)];
    for (const value of rawCandidates) addUrl(candidates, value, baseUrl);

    return {
        candidates: [...new Set(candidates)].slice(0, 6),
        title: values.get("og:title")?.[0] || values.get("twitter:title")?.[0] || null,
        creator: values.get("author")?.[0] || null,
    };
}

async function readPage(response, maxBytes) {
    const declaredSize = Number.parseInt(String(response.headers["content-length"] || "0"), 10);
    if (declaredSize > maxBytes) {
        response.destroy();
        throw new DownloadMethodError("page-metadata", `The page metadata exceeded ${maxBytes} bytes.`);
    }
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of response) {
            size += chunk.byteLength;
            if (size > maxBytes) {
                throw new DownloadMethodError("page-metadata", `The page metadata exceeded ${maxBytes} bytes.`);
            }
            chunks.push(chunk);
        }
    } finally {
        response.destroy();
    }
    return Buffer.concat(chunks, size).toString("utf8");
}

function expectedKind(outputType, mediaKind) {
    if (outputType === "auto") return ["video", "audio", "image"].includes(mediaKind);
    if (outputType === "video") return mediaKind === "video";
    if (outputType === "audio") return mediaKind === "audio";
    return ["image", "video"].includes(mediaKind);
}

export async function downloadFromPageMetadata(rawUrl, attemptDir, options = {}) {
    const timeoutSignal = AbortSignal.timeout(config.httpResponseTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const { response, finalUrl } = await openPublicHttpResponse(rawUrl, {
        signal,
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    });
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        response.destroy();
        throw new DownloadMethodError("page-metadata", `HTTP ${response.statusCode ?? 0}`);
    }
    if (!/text\/html|application\/xhtml/.test(contentType)) {
        response.destroy();
        return await downloadDirectHttp(finalUrl.href, attemptDir, { ...options, methodLabel: "page-metadata" });
    }

    const html = await readPage(response, config.pageMetadataMaxBytes);
    const metadata = extractPageMetadata(html, finalUrl, options.outputType ?? "video");
    if (metadata.candidates.length === 0) {
        throw new DownloadMethodError("page-metadata", "The page exposed no downloadable media metadata.");
    }

    const failures = [];
    for (const candidate of metadata.candidates) {
        try {
            const file = await downloadDirectHttp(candidate, attemptDir, {
                ...options,
                methodLabel: "page-metadata",
                referer: finalUrl.href,
            });
            if (!expectedKind(options.outputType ?? "video", file.mediaKind)) {
                await fs.rm(file.filePath, { force: true });
                throw new DownloadMethodError("page-metadata", `Metadata returned ${file.mediaKind} media.`);
            }
            return {
                ...file,
                metadata: {
                    title: metadata.title,
                    creator: metadata.creator,
                    sourceUrl: finalUrl.href,
                    extractor: "Open Graph",
                },
            };
        } catch (error) {
            if (error?.name === "AbortError" || error?.stopFallback) throw error;
            failures.push(error.publicMessage || error.message);
        }
    }

    throw new DownloadMethodError("page-metadata", failures.slice(0, 3).join(" | "));
}
