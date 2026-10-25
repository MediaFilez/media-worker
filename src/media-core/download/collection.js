import { validateArtifact, findArtifactCandidates, commitArtifact } from "./artifact.js";
import { userError } from "../utils/errors.js";

export const MAX_COLLECTION_ITEMS = 50;

export function isInstagramPost(rawUrl) {
    const url = new URL(rawUrl);
    return (url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com")) && /^\/(?:p|reels?|tv)\//.test(url.pathname);
}

export function mediaCollection(items) {
    if (!items.length) throw new Error("No media matched the requested output type.");
    return items.length === 1 ? items[0] : { ...items[0], items };
}

export function collectionFailure(error) {
    error.incompleteCollection = true;
    return error;
}

export async function validateMediaCollection(items, options = {}) {
    if (items.length > MAX_COLLECTION_ITEMS) {
        throw userError(`A post may contain at most ${MAX_COLLECTION_ITEMS} media files.`, "COLLECTION_TOO_LARGE", { stopFallback: true });
    }
    const validated = [];
    let totalBytes = 0;
    for (const item of items) {
        options.signal?.throwIfAborted();
        const artifact = await validateArtifact(item, { ...options, outputType: "auto", preferredName: item.fileName });
        totalBytes += artifact.sizeBytes;
        if (totalBytes > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
            throw userError("The post exceeds the aggregate download size limit.", "FILE_TOO_LARGE", { stopFallback: true });
        }
        if (options.outputType === "video" && artifact.mediaKind !== "video") continue;
        if (options.outputType === "audio" && !artifact.mediaInfo?.hasAudio) continue;
        validated.push({ ...item, ...artifact });
    }
    return mediaCollection(validated);
}

export async function recoverMediaCollection(attemptDir, options = {}) {
    const candidates = await findArtifactCandidates(attemptDir);
    candidates.sort((a, b) => a.filePath.localeCompare(b.filePath, "en", { numeric: true }));
    options.onCollection?.(candidates.length);
    try {
        return await validateMediaCollection(candidates, options);
    } catch (error) {
        throw collectionFailure(error);
    }
}

export async function commitMediaCollection(artifact, jobDir) {
    if (!artifact.items) return commitArtifact(artifact, jobDir);
    const items = [];
    for (const [index, item] of artifact.items.entries()) {
        items.push(await commitArtifact({ ...item, fileName: `${String(index + 1).padStart(3, "0")}-${item.fileName}` }, jobDir));
    }
    return mediaCollection(items);
}
