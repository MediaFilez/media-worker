import { config } from "../../config.js";
import { DownloadMethodError } from "../../utils/errors.js";
import { downloadFromPageMetadata } from "./pageMetadata.js";

const REDDIT_HOSTS = new Set(["reddit.com", "www.reddit.com", "m.reddit.com", "old.reddit.com", "new.reddit.com", "redd.it"]);

export function redditProxyUrl(rawUrl, proxyHost) {
    const source = new URL(rawUrl);
    if (!REDDIT_HOSTS.has(source.hostname.toLowerCase())) {
        throw new DownloadMethodError("reddit-proxy", "This fallback only accepts Reddit URLs.");
    }

    const proxy = new URL(proxyHost.includes("://") ? proxyHost : `https://${proxyHost}`);
    proxy.pathname = source.pathname;
    proxy.search = source.search;
    proxy.hash = "";
    return proxy;
}

export async function downloadWithRedditProxy(rawUrl, attemptDir, options = {}) {
    const proxyHosts = options.proxyHosts ?? config.redditProxyHosts;
    const pageDownloader = options.pageDownloader ?? downloadFromPageMetadata;
    if (proxyHosts.length === 0) {
        throw new DownloadMethodError("reddit-proxy", "No Reddit embed proxy is configured.");
    }

    const failures = [];
    for (const host of proxyHosts) {
        try {
            const url = redditProxyUrl(rawUrl, host);
            const file = await pageDownloader(url.href, attemptDir, options);
            return {
                ...file,
                method: `reddit-proxy:${url.hostname}`,
                metadata: {
                    ...file.metadata,
                    sourceUrl: rawUrl,
                    extractor: "Reddit proxy metadata",
                },
            };
        } catch (error) {
            if (error?.name === "AbortError" || error?.stopFallback) throw error;
            failures.push(`${host}: ${error.publicMessage || error.message}`);
        }
    }

    throw new DownloadMethodError("reddit-proxy", failures.slice(0, 3).join(" | "));
}
