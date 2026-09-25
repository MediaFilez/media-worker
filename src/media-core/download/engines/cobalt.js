import http from "node:http";
import https from "node:https";
import { config } from "../../config.js";
import { DownloadMethodError } from "../../utils/errors.js";
import { assertPublicHttpUrl, publicDnsLookup } from "../../utils/security.js";
import { preferredVideoHeight } from "../videoQuality.js";
import { downloadDirectHttp } from "./directHttp.js";

let directoryCache = { expiresAt: 0, data: null };
const endpointCooldowns = new Map();
const MAX_COBALT_JSON_BYTES = 1024 * 1024;

const DIRECTORY_SERVICE_HOSTS = [
    ["youtube", ["youtube.com", "youtu.be"]],
    ["tiktok", ["tiktok.com"]],
    ["instagram", ["instagram.com"]],
    ["twitter", ["twitter.com", "x.com"]],
    ["reddit", ["reddit.com", "redd.it"]],
    ["soundcloud", ["soundcloud.com"]],
    ["bilibili", ["bilibili.com", "b23.tv"]],
    ["dailymotion", ["dailymotion.com", "dai.ly"]],
    ["odnoklassniki", ["ok.ru"]],
    ["streamable", ["streamable.com"]],
    ["tumblr", ["tumblr.com"]],
    ["twitchclips", ["twitch.tv"]],
    ["vk", ["vk.com"]],
    ["vimeo", ["vimeo.com"]],
    ["pinterest", ["pinterest.com", "pin.it"]],
    ["rutube", ["rutube.ru"]],
    ["snapchat", ["snapchat.com"]],
    ["facebook", ["facebook.com", "fb.watch"]],
    ["bluesky", ["bsky.app"]],
    ["newgrounds", ["newgrounds.com"]],
    ["loom", ["loom.com"]],
];

function uniqueEndpoints(values) {
    const result = new Set();
    for (const value of values) {
        try {
            result.add(new URL(value).href.replace(/\/$/, ""));
        } catch {
            /* Invalid setting. */
        }
    }
    return [...result];
}

function normalizeServiceName(value) {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function directoryServiceForUrl(rawUrl) {
    let host;
    try {
        host = new URL(rawUrl).hostname.toLowerCase();
    } catch {
        return null;
    }

    return DIRECTORY_SERVICE_HOSTS.find(([, suffixes]) => suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)))?.[0] ?? null;
}

function addDirectoryEndpoint(services, service, endpoint) {
    if (typeof endpoint !== "string") return;
    const key = normalizeServiceName(service);
    if (!services.has(key)) services.set(key, []);
    services.get(key).push(endpoint);
}

function directoryServices(response) {
    const services = new Map();
    const data = response?.data;

    if (Array.isArray(data)) {
        for (const instance of data) {
            if (!instance?.api || instance.online === false || instance.turnstile === true) continue;
            const endpoint = /^https?:\/\//i.test(instance.api) ? instance.api : `https://${instance.api}`;
            for (const [service, result] of Object.entries(instance.tests ?? {})) {
                if (result?.status) addDirectoryEndpoint(services, service, endpoint);
            }
        }
        return services;
    }

    for (const [service, endpoints] of Object.entries(data ?? {})) {
        for (const endpoint of Array.isArray(endpoints) ? endpoints : []) {
            addDirectoryEndpoint(services, service, endpoint);
        }
    }
    return services;
}

export function selectCobaltDirectoryEndpoints(response, rawUrl) {
    const services = directoryServices(response);
    const requestedService = directoryServiceForUrl(rawUrl);
    let endpoints;

    if (requestedService) {
        endpoints = [...services.entries()]
            .filter(([service]) => service === requestedService || (requestedService === "youtube" && service.startsWith("youtube")))
            .flatMap(([, values]) => values);
    } else {
        endpoints = [...services.values()].flat();
    }

    return uniqueEndpoints(endpoints);
}

/**
 * Retrieves Cobalt directory endpoints applicable to a source URL.
 * @param {AbortSignal|null} signal - Optional signal used to cancel the directory request.
 * @param {string} rawUrl - Source URL used to select matching service endpoints.
 * @return {Promise<string[]>} Matching directory endpoint URLs, or an empty array when unavailable.
 */
async function directoryEndpoints(signal, rawUrl) {
    if (!config.cobaltDirectoryEnabled) return [];
    if (directoryCache.expiresAt > Date.now()) {
        return selectCobaltDirectoryEndpoints(directoryCache.data, rawUrl);
    }

    try {
        const response = await fetch(config.cobaltDirectoryUrl, {
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
            headers: { accept: "application/json", "user-agent": config.userAgent },
        });

        if (!response.ok) {
            await closeResponse(response);
            return [];
        }
        const data = await readBoundedJsonResponse(response, MAX_COBALT_JSON_BYTES, "cobalt-directory");
        directoryCache = { expiresAt: Date.now() + 30 * 60_000, data };

        return selectCobaltDirectoryEndpoints(data, rawUrl);
    } catch {
        return [];
    }
}

/**
 * Build the request payload for downloading media through Cobalt.
 * @param {string} rawUrl - The source media URL.
 * @param {string} outputType - The requested output type, such as audio or video.
 * @param {number} targetBytes - The target output size used to select video quality.
 * @return {Object} The Cobalt request payload.
 */
export function cobaltRequestPayload(rawUrl, outputType, targetBytes) {
    const preferredHeight = ["auto", "video"].includes(outputType) ? preferredVideoHeight(targetBytes) : null;
    return {
        url: rawUrl,
        videoQuality: preferredHeight ? String(preferredHeight) : "max",
        youtubeVideoCodec: "h264",
        youtubeVideoContainer: "mp4",
        audioFormat: outputType === "audio" ? "mp3" : "best",
        downloadMode: outputType === "audio" ? "audio" : "auto",
        filenameStyle: "basic",
        disableMetadata: false,
        localProcessing: "disabled",
    };
}

export function cobaltRequestHeaders(trustedEndpoint) {
    const result = { accept: "application/json", "content-type": "application/json", "user-agent": config.userAgent };
    if (trustedEndpoint && config.cobaltApiKey) {
        result.authorization = `${config.cobaltAuthScheme} ${config.cobaltApiKey}`;
    }
    return result;
}

function responseHeader(response, name) {
    if (typeof response.headers?.get === "function") return response.headers.get(name);
    const value = response.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : (value ?? null);
}

async function closeResponse(response) {
    if (typeof response.destroy === "function") {
        response.destroy();
        return;
    }
    await response.body?.cancel().catch(() => {});
}

export async function readBoundedJsonResponse(response, maxBytes, method) {
    const declaredSize = Number.parseInt(responseHeader(response, "content-length") || "0", 10);
    if (declaredSize > maxBytes) {
        await closeResponse(response);
        throw new DownloadMethodError(method, `The response exceeded ${maxBytes} bytes.`);
    }

    const chunks = [];
    let size = 0;
    const body = response.body ?? response;
    if (!body) throw new DownloadMethodError(method, "The response had no body.");
    for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > maxBytes) {
            await closeResponse(response);
            throw new DownloadMethodError(method, `The response exceeded ${maxBytes} bytes.`);
        }
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function requestCobaltEndpoint(endpointUrl, requestBody, signal, trustedEndpoint) {
    const transport = endpointUrl.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
        const request = transport.request(
            endpointUrl,
            {
                method: "POST",
                signal,
                lookup: trustedEndpoint ? undefined : publicDnsLookup,
                headers: {
                    ...cobaltRequestHeaders(trustedEndpoint),
                    "content-length": Buffer.byteLength(requestBody),
                },
            },
            resolve,
        );
        request.once("error", reject);
        request.end(requestBody);
    });
}

function mediaFromResponse(data, outputType) {
    if (typeof data?.url === "string") return { url: data.url, fileName: data.filename };
    if (outputType === "audio" && typeof data?.audio === "string") {
        return { url: data.audio, fileName: data.audioFilename || data.filename };
    }
    const picker = Array.isArray(data?.picker) ? data.picker : [];

    const preferred =
        picker.find((item) => {
            if (!item?.url) return false;
            if (["image", "thumbnail"].includes(outputType)) return ["photo", "image"].includes(item.type);
            if (outputType === "audio") return item.type === "audio";
            return ["video", "gif"].includes(item.type) || !item.type;
        }) || picker.find((item) => item?.url);

    return preferred ? { url: preferred.url, fileName: preferred.filename || data.filename } : null;
}

function availableEndpoints(endpoints) {
    const now = Date.now();
    const available = endpoints.filter((endpoint) => (endpointCooldowns.get(endpoint) ?? 0) <= now);
    if (available.length > 0) return available;
    return [...endpoints].sort((left, right) => (endpointCooldowns.get(left) ?? 0) - (endpointCooldowns.get(right) ?? 0));
}

export function resetCobaltEndpointHealth() {
    endpointCooldowns.clear();
    directoryCache = { expiresAt: 0, data: null };
}

function cobaltMessage(data, status) {
    return data?.error?.context?.service || data?.error?.code || data?.text || `Cobalt returned HTTP ${status}.`;
}

async function callEndpoint(endpoint, rawUrl, attemptDir, options, trustedEndpoint) {
    let endpointUrl;
    try {
        endpointUrl = await assertPublicHttpUrl(endpoint, {
            trustedHosts: trustedEndpoint ? [new URL(endpoint).hostname] : [],
        });
    } catch (error) {
        throw new DownloadMethodError("cobalt", "Cobalt directory returned a non-public endpoint.", {
            cause: error,
        });
    }
    const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(config.cobaltEndpointTimeoutMs)])
        : AbortSignal.timeout(config.cobaltEndpointTimeoutMs);
    const response = await requestCobaltEndpoint(
        endpointUrl,
        JSON.stringify(cobaltRequestPayload(rawUrl, options.outputType ?? "video", options.targetBytes)),
        signal,
        trustedEndpoint,
    );
    const status = response.statusCode ?? 0;
    let data;

    try {
        data = await readBoundedJsonResponse(response, MAX_COBALT_JSON_BYTES, "cobalt");
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new DownloadMethodError("cobalt", `Cobalt returned non-JSON HTTP ${status}.`);
        }
        throw error;
    }

    if (status < 200 || status >= 300 || data?.status === "error") {
        throw new DownloadMethodError("cobalt", cobaltMessage(data, status));
    }

    if (data?.status === "local-processing")
        throw new DownloadMethodError("cobalt", "This Cobalt response requires local processing, which was disabled.");

    const media = mediaFromResponse(data, options.outputType);
    if (!media) throw new DownloadMethodError("cobalt", `Cobalt returned ${data?.status || "an unknown status"} without downloadable media.`);

    let file;
    try {
        file = await downloadDirectHttp(media.url, attemptDir, {
            ...options,
            preferredName: media.fileName,
            methodLabel: `cobalt:${endpointUrl.hostname}`,
            trustedHosts: trustedEndpoint ? [endpointUrl.hostname] : [],
        });
    } catch (error) {
        if (["DNS_FAILED", "INVALID_URL", "PRIVATE_URL"].includes(error?.code)) {
            throw new DownloadMethodError("cobalt", "Cobalt returned an unsafe media URL.", { cause: error });
        }
        throw error;
    }

    return {
        ...file,
        metadata: data.metadata
            ? {
                  title: data.metadata.title,
                  creator: data.metadata.artist || data.metadata.author,
                  durationSeconds: data.metadata.duration,
                  sourceUrl: rawUrl,
                  extractor: "Cobalt",
              }
            : { sourceUrl: rawUrl, extractor: "Cobalt" },
    };
}

export async function downloadWithCobalt(rawUrl, attemptDir, options = {}) {
    const configuredEndpoints = uniqueEndpoints(config.cobaltApiEndpoints);
    const trustedEndpoints = new Set(configuredEndpoints);
    const endpoints = uniqueEndpoints([...configuredEndpoints, ...(await directoryEndpoints(options.signal, rawUrl))]).slice(
        0,
        config.cobaltMaxEndpoints,
    );
    if (endpoints.length === 0) throw new DownloadMethodError("cobalt", "No Cobalt instance is configured.");

    const failures = [];
    for (const endpoint of availableEndpoints(endpoints)) {
        try {
            const result = await callEndpoint(endpoint, rawUrl, attemptDir, options, trustedEndpoints.has(endpoint));
            endpointCooldowns.delete(endpoint);
            return result;
        } catch (error) {
            if (error?.name === "AbortError" || error?.stopFallback) throw error;
            endpointCooldowns.set(endpoint, Date.now() + config.cobaltFailureCooldownMs);
            failures.push(`${new URL(endpoint).hostname}: ${error.publicMessage || error.message}`);
        }
    }
    throw new DownloadMethodError("cobalt", failures.slice(0, 3).join(" | "));
}
