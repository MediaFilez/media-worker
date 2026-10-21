export class UserFacingError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "UserFacingError";
        this.code = options.code ?? "USER_ERROR";
        this.stopFallback = options.stopFallback ?? false;
        this.cause = options.cause;
    }
}

export class DownloadMethodError extends Error {
    constructor(method, message, options = {}) {
        super(message);
        this.name = "DownloadMethodError";
        this.method = method;
        this.publicMessage = options.publicMessage ?? message;
        this.cause = options.cause;
    }
}

export class DeliveryUnknownError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = "DeliveryUnknownError";
        this.responseLocked = true;
        this.cause = options.cause;
    }
}

/**
 * Creates an error intended for presentation to the user.
 * @param {string} message - The message describing the error.
 * @param {string} [code="USER_ERROR"] - The error code.
 * @param {Object} [options] - Additional error options.
 * @returns {UserFacingError} The configured user-facing error.
 */
export function userError(message, code = "USER_ERROR", options = {}) {
    return new UserFacingError(message, { code, ...options });
}

export function isUserFacingError(error) {
    return error instanceof UserFacingError || error?.name === "UserFacingError";
}

export function isRetryableError(error) {
    if (!(error instanceof Error)) return false;
    if (
        error.stopFallback ||
        [
            "INVALID_URL",
            "PRIVATE_URL",
            "UNSUPPORTED_MEDIA",
            "WRONG_MEDIA_TYPE",
            "FILE_TOO_LARGE",
            "IDENTITY_CONFLICT",
            "JOB_CANCELLED",
            "TEMP_LIMIT",
        ].includes(error.code)
    )
        return false;
    return !["AbortError", "ZodError", "TypeError"].includes(error.name);
}

export function redactSensitive(value) {
    return String(value)
        .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
            try {
                const url = new URL(raw);
                if (url.username || url.password) {
                    url.username = "redacted";
                    url.password = "";
                }
                if (url.search) url.search = "?redacted";
                if (url.hash) url.hash = "#redacted";
                return url.href;
            } catch {
                return "[redacted URL]";
            }
        })
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
        .replace(/((?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|password)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]");
}

export function messageForError(error) {
    if (isUserFacingError(error)) return redactSensitive(error.message);
    if (error instanceof DeliveryUnknownError || error?.name === "DeliveryUnknownError") return redactSensitive(error.message);
    if (typeof error?.publicMessage === "string") return redactSensitive(error.publicMessage);
    if (error?.name === "TimeoutError") return "The job timed out. Try a smaller file or a faster source URL.";
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        return "The job was cancelled before it finished. Try again with a smaller file.";
    }
    return "The request failed while processing the media. Try another URL or a smaller file.";
}
