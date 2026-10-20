import http from "node:http";
import https from "node:https";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertPublicHttpUrl, publicDnsLookup } from "./security.js";
import { config } from "../config.js";
import { jobResources } from "./resources.js";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";
import { userError } from "./errors.js";

const fetchContext = new AsyncLocalStorage();
export function withFetchSignal(signal, callback) {
    return fetchContext.run(signal, callback);
}

// Fetch-compatible transport for extractor requests; every redirect uses a new guarded socket.
export async function publicFetch(input, init = {}, options = {}) {
    const request = new Request(input, init);
    const jobSignal = options.signal ?? jobResources()?.signal ?? fetchContext.getStore();
    const signal = AbortSignal.any([
        request.signal,
        ...(jobSignal ? [jobSignal] : []),
        AbortSignal.timeout(options.timeoutMs ?? config.jobTimeoutMs),
    ]);
    let url = await assertPublicHttpUrl(request.url, { ...options, signal });
    let method = request.method;
    let body = null;
    if (request.body) {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request.body) {
            signal.throwIfAborted();
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) throw new Error("Extractor request body exceeded 4 MB.");
            chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks, bytes);
    }
    const headers = Object.fromEntries(request.headers);
    delete headers.host;
    delete headers["accept-encoding"];
    headers["accept-encoding"] = "identity";

    for (let hop = 0; hop <= 5; hop += 1) {
        signal.throwIfAborted();
        const response = await new Promise((resolve, reject) => {
            const trusted = (options.trustedHosts ?? []).includes(url.hostname) || (options.trustedOrigins ?? []).includes(url.origin);
            const outgoing = (url.protocol === "https:" ? https : http).request(
                url,
                {
                    method,
                    headers,
                    signal,
                    agent: false,
                    lookup: trusted ? undefined : publicDnsLookup,
                },
                resolve,
            );
            outgoing.once("error", reject);
            outgoing.end(body);
        }).catch((error) => {
            signal.throwIfAborted();
            if (error.code === "ERR_PRIVATE_ADDRESS") {
                throw userError("Extractor DNS resolved to a private or reserved address.", "PRIVATE_URL", { stopFallback: true, cause: error });
            }
            throw error;
        });
        if ([301, 302, 303, 307, 308].includes(response.statusCode) && request.redirect !== "manual") {
            response.destroy();
            if (request.redirect === "error" || !response.headers.location || hop === 5) throw new Error("Extractor redirect was refused.");
            const next = await assertPublicHttpUrl(new URL(response.headers.location, url).href, { ...options, signal });
            if (next.origin !== url.origin) {
                delete headers.authorization;
                delete headers.cookie;
            }
            if (response.statusCode === 303 || ([301, 302].includes(response.statusCode) && method === "POST")) {
                method = "GET";
                body = null;
                delete headers["content-type"];
                delete headers["content-length"];
            }
            url = next;
            continue;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, item);
        }
        if (method === "HEAD" || [204, 205, 304].includes(response.statusCode)) {
            response.destroy();
            return new Response(null, { status: response.statusCode, headers: responseHeaders });
        }
        let bytes = 0;
        const limiter = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                callback(
                    bytes > (options.maxBytes ?? config.maxDownloadBytes) ? new Error("Extractor response exceeded its byte limit.") : null,
                    chunk,
                );
            },
        });
        // Attach rejection handling immediately; the consumer observes errors on the returned body.
        const decode = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[response.headers["content-encoding"]];
        if (decode) {
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
        }
        void pipeline(...[response, ...(decode ? [decode()] : []), limiter], { signal }).catch(() => undefined);
        return new Response(Readable.toWeb(limiter), { status: response.statusCode, headers: responseHeaders });
    }
    throw new Error("Extractor redirected too many times.");
}
