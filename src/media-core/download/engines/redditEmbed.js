import fs from "node:fs/promises";
import { config } from "../../config.js";
import { DownloadMethodError } from "../../utils/errors.js";
import { decodeHtmlEntities } from "../../utils/htmlEntities.js";
import { downloadDirectHttp, openPublicHttpResponse } from "./directHttp.js";
import { downloadWithYtDlp } from "./ytDlp.js";

const REDDIT_PAGE_HOSTS = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]);
const REDDIT_MEDIA_HOSTS = new Set(["i.redd.it", "preview.redd.it", "external-preview.redd.it", "v.redd.it"]);

function addRedditMediaUrl(candidates, value) {
    if (!value) return;
    try {
        const url = new URL(decodeHtmlEntities(value));
        if (["http:", "https:"].includes(url.protocol) && REDDIT_MEDIA_HOSTS.has(url.hostname.toLowerCase())) {
            candidates.push(url.href);
        }
    } catch {
        // Ignore malformed embed data and keep looking for another media candidate.
    }
}

export function extractRedditPostMedia(html) {
    const candidates = [];
    let mediaKind = null;

    for (const tag of html.matchAll(/<(?:shreddit-screenview-data|faceplate-tracker)\b[^>]*>/gi)) {
        const encoded = tag[0].match(/\b(?:data|data-faceplate-tracking-context)="([^"]+)"/i)?.[1];
        if (!encoded) continue;
        try {
            const post = JSON.parse(decodeHtmlEntities(encoded)).post;
            if (!post || typeof post !== "object") continue;
            if (["image", "video"].includes(post.type)) mediaKind ??= post.type;
            addRedditMediaUrl(candidates, post.url);
        } catch {
            continue;
        }
    }

    const mediaTags = mediaKind === "video" ? /<(?:video|source)\b[^>]*>/gi : /<img\b[^>]*>/gi;
    for (const tag of html.matchAll(mediaTags)) {
        const source = tag[0].match(/\bsrc="([^"]+)"/i)?.[1];
        addRedditMediaUrl(candidates, source);
    }

    return { candidates: [...new Set(candidates)].slice(0, 6), mediaKind };
}

async function readEmbedPage(response) {
    const maxBytes = config.pageMetadataMaxBytes;
    const chunks = [];
    let size = 0;
    try {
        for await (const chunk of response) {
            size += chunk.byteLength;
            if (size > maxBytes) {
                throw new DownloadMethodError("reddit-embed", `The Reddit embed exceeded ${maxBytes} bytes.`);
            }
            chunks.push(chunk);
        }
    } finally {
        response.destroy();
    }
    return Buffer.concat(chunks, size).toString("utf8");
}

function requireSuccessfulResponse(response) {
    if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) return;
    response.destroy();
    throw new DownloadMethodError("reddit-embed", `HTTP ${response.statusCode ?? 0}`);
}

function acceptsMediaKind(outputType, mediaKind) {
    if (outputType === "auto") return ["video", "audio", "image"].includes(mediaKind);
    if (outputType === "video") return mediaKind === "video";
    if (outputType === "audio") return mediaKind !== "image";
    return ["image", "video"].includes(mediaKind);
}

async function resolveRedditPage(rawUrl, signal) {
    const { response, finalUrl } = await openPublicHttpResponse(rawUrl, {
        signal,
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    });
    requireSuccessfulResponse(response);
    response.destroy();

    if (!REDDIT_PAGE_HOSTS.has(finalUrl.hostname.toLowerCase())) {
        throw new DownloadMethodError("reddit-embed", "The share link redirected outside Reddit.");
    }
    return finalUrl;
}

async function tryCandidate(candidate, attemptDir, options) {
    if (new URL(candidate).hostname.toLowerCase() === "v.redd.it") {
        return await downloadWithYtDlp(candidate, attemptDir, options);
    }
    return await downloadDirectHttp(candidate, attemptDir, { ...options, methodLabel: "reddit-embed" });
}

async function requireAcceptedCandidate(candidate, attemptDir, finalUrl, options) {
    const outputType = options.outputType ?? "video";
    const file = await tryCandidate(candidate, attemptDir, options);
    if (!acceptsMediaKind(outputType, file.mediaKind)) {
        await fs.rm(file.filePath, { force: true });
        throw new DownloadMethodError("reddit-embed", `The candidate returned ${file.mediaKind} media.`);
    }
    return {
        ...file,
        method: "reddit-embed",
        metadata: { sourceUrl: finalUrl.href, extractor: "Reddit Embed" },
    };
}

export async function downloadFromRedditEmbed(rawUrl, attemptDir, options = {}) {
    const timeoutSignal = AbortSignal.timeout(config.httpResponseTimeoutMs);
    const resolutionSignal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    const finalUrl = await resolveRedditPage(rawUrl, resolutionSignal);
    const wrappedUrl = finalUrl.pathname === "/media" ? finalUrl.searchParams.get("url") : null;

    if (wrappedUrl) {
        return await requireAcceptedCandidate(wrappedUrl, attemptDir, finalUrl, options);
    }

    if (!/\/comments\/[a-z0-9]+/i.test(finalUrl.pathname)) {
        throw new DownloadMethodError("reddit-embed", "The Reddit share link did not resolve to a post.");
    }

    const embedUrl = new URL(finalUrl);
    embedUrl.hostname = "embed.reddit.com";
    embedUrl.search = "";
    const { response } = await openPublicHttpResponse(embedUrl.href, {
        signal: resolutionSignal,
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    });
    requireSuccessfulResponse(response);
    const media = extractRedditPostMedia(await readEmbedPage(response));
    const outputType = options.outputType ?? "video";

    if (media.mediaKind && !acceptsMediaKind(outputType, media.mediaKind)) {
        throw new DownloadMethodError("reddit-embed", `The Reddit post contains ${media.mediaKind} media, not ${outputType}.`);
    }
    if (media.candidates.length === 0) {
        throw new DownloadMethodError("reddit-embed", "The Reddit embed exposed no downloadable media.");
    }

    const failures = [];
    for (const candidate of media.candidates) {
        try {
            return await requireAcceptedCandidate(candidate, attemptDir, finalUrl, options);
        } catch (error) {
            if (error?.name === "AbortError" || error?.stopFallback) throw error;
            failures.push(error.publicMessage || error.message);
        }
    }

    throw new DownloadMethodError("reddit-embed", failures.slice(0, 3).join(" | "));
}
