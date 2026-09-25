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
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
    if (normalized.startsWith("ff") || normalized.startsWith("2001:db8:")) return true;

    if (normalized.startsWith("::ffff:")) {
        return isBlockedIpv4(normalized.slice("::ffff:".length));
    }

    return false;
}

export function isBlockedAddress(address) {
    const version = net.isIP(address);
    if (version === 4) return isBlockedIpv4(address);
    if (version === 6) return isBlockedIpv6(address);
    return true;
}

export async function assertPublicHttpUrl(rawUrl, options = {}) {
    const url = parsePublicHttpUrl(rawUrl);
    const hostname = url.hostname;
    const trustedHosts = new Set((options.trustedHosts ?? []).map((host) => host.toLowerCase()));
    if (trustedHosts.has(hostname.toLowerCase())) return url;

    if (net.isIP(hostname)) {
        if (isBlockedAddress(hostname)) {
            throw userError("Local or private network URLs are not allowed.", "PRIVATE_URL", { stopFallback: true });
        }
        return url;
    }

    let records;
    try {
        records = await dnsPromises.lookup(hostname, { all: true, verbatim: false });
    } catch {
        throw userError("The URL host could not be resolved.", "DNS_FAILED", { stopFallback: true });
    }

    if (records.length === 0 || records.some((record) => isBlockedAddress(record.address))) {
        throw userError("Local or private network URLs are not allowed.", "PRIVATE_URL", { stopFallback: true });
    }

    return url;
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
