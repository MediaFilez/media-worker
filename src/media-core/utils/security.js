import dns, { promises as dnsPromises } from "node:dns";
import net from "node:net";
import { userError } from "./errors.js";

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);

export function parsePublicHttpUrl(rawUrl) {
    let url;

    try {
        url = new URL(rawUrl);
    } catch {
        throw userError("The URL is invalid. Send a full http:// or https:// URL.", "INVALID_URL", {
            stopFallback: true,
        });
    }

    if (!["http:", "https:"].includes(url.protocol)) {
        throw userError("Only http:// and https:// URLs are supported.", "INVALID_URL", { stopFallback: true });
    }
    if (url.username || url.password) throw userError("URLs containing credentials are not allowed.", "INVALID_URL", { stopFallback: true });

    if (!url.hostname || BLOCKED_HOSTS.has(url.hostname.toLowerCase())) {
        throw userError("Local or private network URLs are not allowed.", "PRIVATE_URL", { stopFallback: true });
    }

    return url;
}

function isBlockedIpv4(address) {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;

    return false;
}

function isBlockedIpv6(address) {
    let normalized;
    try {
        normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    } catch {
        return true;
    }
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return true;

    if (normalized.startsWith("::ffff:")) {
        const words = normalized.slice(7).split(":");
        const value = words.map((word) => Number.parseInt(word, 16));
        if (value.length !== 2) return true;
        return isBlockedIpv4([value[0] >> 8, value[0] & 255, value[1] >> 8, value[1] & 255].join("."));
    }
    // Only globally routed unicast; reject transition ranges that can embed private IPv4.
    const words = normalized.split(":");
    const second = Number.parseInt(words[1] || "0", 16);
    return (
        !/^[23]/.test(normalized) ||
        normalized.startsWith("2002:") ||
        normalized.startsWith("3fff:") ||
        (words[0] === "2001" && (second === 0 || second === 2 || (second >= 0x10 && second <= 0x2f)))
    );
}

export function isBlockedAddress(address) {
    const version = net.isIP(address);
    if (version === 4) return isBlockedIpv4(address);
    if (version === 6) return isBlockedIpv6(address);
    return true;
}

export async function assertPublicHttpUrl(rawUrl, options = {}) {
    options.signal?.throwIfAborted();
    const url = parsePublicHttpUrl(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const trustedHosts = new Set((options.trustedHosts ?? []).map((host) => host.toLowerCase()));
    if (trustedHosts.has(hostname.toLowerCase()) || (options.trustedOrigins ?? []).includes(url.origin)) return url;

    if (net.isIP(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw userError("Local or private network URLs are not allowed.", "PRIVATE_URL", { stopFallback: true });
        }
        return url;
    }

    let records;
    try {
        records = await abortableLookup(hostname, options.signal);
    } catch {
        options.signal?.throwIfAborted();
        throw userError("The URL host could not be resolved.", "DNS_FAILED", { stopFallback: true });
    }

    if (records.length === 0 || records.some((record) => isBlockedAddress(record.address))) {
        throw userError("Local or private network URLs are not allowed.", "PRIVATE_URL", { stopFallback: true });
    }

    return url;
}

export async function abortableLookup(hostname, parentSignal) {
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(parentSignal ? [parentSignal] : [])]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        dnsPromises
            .lookup(hostname, { all: true, verbatim: false })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

export function publicDnsLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error);
        const records = Array.isArray(addresses) ? addresses : [addresses];
        if (records.length === 0 || records.some((record) => isBlockedAddress(record.address))) {
            const blocked = new Error("DNS resolved to a private or reserved address.");
            blocked.code = "ERR_PRIVATE_ADDRESS";
            return callback(blocked);
        }
        if (options?.all) return callback(null, records);
        return callback(null, records[0].address, records[0].family);
    });
}
