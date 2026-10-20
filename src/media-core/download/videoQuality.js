import { MB } from "../config.js";

export function preferredVideoHeight(targetBytes) {
    if (!Number.isFinite(targetBytes) || targetBytes <= 0) return null;
    if (targetBytes <= 10 * MB) return 360;
    if (targetBytes <= 50 * MB) return 480;
    if (targetBytes <= 100 * MB) return 720;
    return null;
}

export function ytDlpFormatSelector(outputType, targetBytes, requestedHeight = null) {
    if (outputType === "audio") return "ba/b";

    const fallback = "bv*+ba/b";
    const height = requestedHeight || preferredVideoHeight(targetBytes);
    if (!height) return fallback;

    return [`bv*[height<=${height}]+ba`, `b[height<=${height}]`, fallback].join("/");
}
