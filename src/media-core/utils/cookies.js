import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function copyCookiesForAttempt(sourcePath, attemptDir) {
    if (!sourcePath) return null;
    const info = await fs.stat(sourcePath);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("The configured cookie file is invalid or too large.");
    const target = path.join(attemptDir, `.media-cookies-${crypto.randomUUID()}.txt`);
    await fs.writeFile(target, await fs.readFile(sourcePath), { flag: "wx", mode: 0o600 });
    await fs.chmod(target, 0o600);
    return target;
}
