import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { config } from "../../config.js";
import { describeFile, extensionFromMime, makeSafeFileName } from "../../utils/files.js";
import { DownloadMethodError, userError } from "../../utils/errors.js";
import { assertPublicHttpUrl, publicDnsLookup } from "../../utils/security.js";
import { formatBytes } from "../../utils/format.js";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function parseContentDisposition(value) {
    if (!value) return null;
    const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (encoded) {
        try {
            return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
        } catch {
            return encoded;
        }
    }
    return value.match(/filename="?([^";]+)"?/i)?.[1]?.trim() ?? null;
}

function fallbackName(url, contentType) {
    const base = path.basename(url.pathname);
    if (base && base !== "/") return base;
    const extension = extensionFromMime(contentType);
    return `download-${randomUUID().slice(0, 8)}${extension ? `.${extension}` : ""}`;
}

function transferController(parentSignal, responseTimeoutMs) {
    const controller = new AbortController();
    let reason = null;
    const abortFromParent = () => controller.abort(parentSignal.reason);
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();

    let timer = setTimeout(() => {
        reason = "response-timeout";
        controller.abort();
    }, responseTimeoutMs);

    return {
        signal: controller.signal,
        reason: () => reason,
        startIdleTimer(idleTimeoutMs) {
            clearTimeout(timer);
            const reset = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    reason = "idle-timeout";
                    controller.abort();
                }, idleTimeoutMs);
            };
            reset();
            return reset;
        },
        dispose() {
            clearTimeout(timer);
            parentSignal?.removeEventListener("abort", abortFromParent);
        },
    };
}

function isConnectionCloseError(error) {
    if (!error) return false;
    const closeCodes = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]);
    if (error.name === "SocketError" || closeCodes.has(error.code)) return true;
    if (/other side closed|premature close|terminated/i.test(error.message || "")) return true;
    return error.cause && error.cause !== error ? isConnectionCloseError(error.cause) : false;
}

function hasErrorCode(error, code, seen = new Set()) {
    if (!error || seen.has(error)) return false;
    seen.add(error);
    if (error.code === code) return true;
    if (hasErrorCode(error.cause, code, seen)) return true;
    return Array.isArray(error.errors) && error.errors.some((item) => hasErrorCode(item, code, seen));
}

function responseHeader(response, name) {
    const value = response.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : (value ?? null);
}

/**
 * Requests media from an HTTP or HTTPS URL.
 * @param {URL} url - The URL to request.
 * @param {Object} options - Request configuration.
 * @param {AbortSignal} options.signal - Signal used to cancel the request.
 * @param {Set<string>} options.trustedHosts - Hostnames allowed to bypass public DNS resolution.
 * @param {string} [options.referer] - Referer header value.
 * @param {Object} [options.headers] - Additional request headers.
 * @return {Promise<import("node:http").IncomingMessage>} The HTTP response.
 */
function requestMedia(url, options) {
    const transport = url.protocol === "https:" ? https : http;
    const trusted = options.trustedHosts.has(url.hostname.toLowerCase());

    return new Promise((resolve, reject) => {
        const request = transport.request(
            url,
            {
                method: "GET",
                signal: options.signal,
                lookup: trusted ? undefined : publicDnsLookup,
                headers: {
                    "user-agent": config.userAgent,
                    accept: "video/*,image/*,audio/*,*/*;q=0.8",
                    "accept-language": "en-US,en;q=0.8",
                    ...(options.referer ? { referer: options.referer } : {}),
                    ...options.headers,
                },
            },
            resolve,
        );
        request.once("error", reject);
        request.end();
    });
}

export async function openPublicHttpResponse(rawUrl, options = {}) {
    const trustedHosts = options.trustedHosts ?? [];
    let current = await assertPublicHttpUrl(rawUrl, { trustedHosts });
    const trusted = new Set(trustedHosts.map((host) => host.toLowerCase()));

    for (let redirect = 0; redirect <= 5; redirect += 1) {
        let response;
        try {
            response = await requestMedia(current, {
                signal: options.signal,
                trustedHosts: trusted,
                referer: options.referer,
                headers: options.headers,
            });
        } catch (error) {
            if (hasErrorCode(error, "ERR_PRIVATE_ADDRESS")) {
                throw userError("Local or private network URLs are not allowed.", "PRIVATE_URL", {
                    stopFallback: true,
                    cause: error,
                });
            }
            throw error;
        }
        if (!REDIRECTS.has(response.statusCode)) return { response, finalUrl: current };
        response.destroy();
        const location = responseHeader(response, "location");
        if (!location) throw new DownloadMethodError("direct-http", `HTTP ${response.statusCode} redirect had no Location header.`);
        current = await assertPublicHttpUrl(new URL(location, current).href, { trustedHosts });
    }
    throw new DownloadMethodError("direct-http", "The server redirected too many times.");
}

export async function downloadDirectHttp(rawUrl, attemptDir, options = {}) {
    const method = options.methodLabel ?? "direct-http";
    const maxBytes = options.maxBytes ?? config.maxDownloadBytes;
    const transfer = transferController(options.signal, options.responseTimeoutMs ?? config.httpResponseTimeoutMs);
    let partialPath;
    let handle;
    let downloadedBytes = 0;
    let expectedBytes = 0;
    let finalName;
    let finalUrlValue;
    let finalContentType;

    try {
        const { response, finalUrl } = await openPublicHttpResponse(rawUrl, {
            signal: transfer.signal,
            trustedHosts: options.trustedHosts,
            referer: options.referer,
        });
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
            response.destroy();
            throw new DownloadMethodError(method, `HTTP ${response.statusCode ?? 0} ${response.statusMessage || ""}`.trim());
        }

        finalContentType = responseHeader(response, "content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        finalUrlValue = finalUrl.href;
        if (/text\/html|application\/xhtml/i.test(finalContentType)) {
            response.destroy();
            throw new DownloadMethodError(method, "The URL returned a web page instead of media.");
        }
        expectedBytes = Number.parseInt(responseHeader(response, "content-length") || "0", 10);
        if (expectedBytes > maxBytes) {
            response.destroy();
            throw userError(`The source file is ${formatBytes(expectedBytes)}. The limit is ${formatBytes(maxBytes)}.`, "FILE_TOO_LARGE", {
                stopFallback: true,
            });
        }

        finalName = makeSafeFileName(
            options.preferredName ||
                parseContentDisposition(responseHeader(response, "content-disposition")) ||
                fallbackName(finalUrl, finalContentType),
            "download",
            extensionFromMime(finalContentType),
        );
        partialPath = path.join(attemptDir, `${randomUUID()}.part`);
        handle = await fs.open(partialPath, "wx");
        const resetIdleTimer = transfer.startIdleTimer(options.idleTimeoutMs ?? config.httpIdleTimeoutMs);
        for await (const chunk of response) {
            resetIdleTimer();
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > maxBytes) {
                throw userError(`The download exceeded ${formatBytes(maxBytes)}.`, "FILE_TOO_LARGE", {
                    stopFallback: true,
                });
            }
            await handle.write(chunk);
            options.onProgress?.({
                downloadedBytes,
                totalBytes: expectedBytes || null,
                percent: expectedBytes ? (downloadedBytes / expectedBytes) * 100 : null,
            });
        }
        await handle.close();
        handle = null;

        const finalPath = path.join(attemptDir, finalName);
        await fs.rename(partialPath, finalPath);
        partialPath = null;
        return {
            ...(await describeFile(finalPath, finalName, "download", finalContentType)),
            method,
            sourceUrl: finalUrlValue,
            metadata: { sourceUrl: finalUrlValue, contentType: finalContentType },
        };
    } catch (error) {
        await handle?.close().catch(() => {});
        handle = null;
        if (partialPath && expectedBytes > 0 && downloadedBytes === expectedBytes && finalName && isConnectionCloseError(error)) {
            const finalPath = path.join(attemptDir, finalName);
            await fs.rename(partialPath, finalPath);
            partialPath = null;
            return {
                ...(await describeFile(finalPath, finalName, "download", finalContentType)),
                method,
                sourceUrl: finalUrlValue,
                metadata: { sourceUrl: finalUrlValue, contentType: finalContentType },
                recoveredFromConnectionClose: true,
            };
        }
        if (partialPath) await fs.rm(partialPath, { force: true }).catch(() => {});
        if (error instanceof DownloadMethodError || error?.name === "UserFacingError") throw error;
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (transfer.reason() === "response-timeout") {
            throw new DownloadMethodError(method, "The media server did not start responding in time.", {
                cause: error,
            });
        }
        if (transfer.reason() === "idle-timeout") {
            throw new DownloadMethodError(method, "The media transfer stalled before it finished.", { cause: error });
        }
        const detail = error?.code ? `${error.code}: ${error.message}` : error?.message || "The connection closed unexpectedly.";
        throw new DownloadMethodError(method, detail, { cause: error });
    } finally {
        transfer.dispose();
    }
}
