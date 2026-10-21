import fs from "node:fs/promises";

/** Fail before claiming jobs when a cookie bind mount is missing or unreadable. */
export async function validateCookieFile(cookiePath: string | null): Promise<void> {
    if (!cookiePath) return;
    const info = await fs.stat(cookiePath);
    if (!info.isFile() || info.size === 0 || info.size > 8 * 1024 * 1024) {
        throw new Error("MEDIA_COOKIES_FILE must be a nonempty Netscape cookie file smaller than 8 MiB.");
    }
    const file = await fs.open(cookiePath, "r");
    try {
        const buffer = Buffer.alloc(256);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(buffer.subarray(0, bytesRead).toString("utf8"))) {
            throw new Error("MEDIA_COOKIES_FILE must have a Netscape cookie file header.");
        }
    } finally {
        await file.close();
    }
}
