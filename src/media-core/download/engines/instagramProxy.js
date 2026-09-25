import { config } from "../../config.js";
import { DownloadMethodError } from "../../utils/errors.js";
import { downloadDirectHttp } from "./directHttp.js";

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);

function proxyUrl(rawUrl, proxyHost) {
    const source = new URL(rawUrl);
    if (!INSTAGRAM_HOSTS.has(source.hostname.toLowerCase())) {
        throw new DownloadMethodError("instagram-proxy", "This fallback only accepts Instagram URLs.");
    }

    const proxy = new URL(proxyHost.includes("://") ? proxyHost : `https://${proxyHost}`);
    proxy.pathname = source.pathname;
    proxy.search = source.search;
    proxy.hash = "";
    return proxy;
}

export async function downloadWithInstagramProxy(rawUrl, attemptDir, options = {}) {
    if (config.instagramProxyHosts.length === 0) {
        throw new DownloadMethodError("instagram-proxy", "No Instagram embed proxy is configured.");
    }

    const failures = [];
    for (const host of config.instagramProxyHosts) {
        try {
            const url = proxyUrl(rawUrl, host);
            return await downloadDirectHttp(url.href, attemptDir, {
                ...options,
                methodLabel: `instagram-proxy:${url.hostname}`,
            });
        } catch (error) {
            if (error?.name === "AbortError" || error?.stopFallback) throw error;
            failures.push(`${host}: ${error.publicMessage || error.message}`);
        }
    }

    throw new DownloadMethodError("instagram-proxy", failures.slice(0, 3).join(" | "));
}
