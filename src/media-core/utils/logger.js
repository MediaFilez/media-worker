const COLORS = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
    green: "\x1b[32m",
};

function timestamp() {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function format(level, color, args) {
    const ts = `${COLORS.gray}${timestamp()}${COLORS.reset}`;
    const tag = `${color}[${level}]${COLORS.reset}`;
    return [ts, tag, ...args];
}

function debugEnabled() {
    return ["1", "true", "yes", "on"].includes(String(process.env.DEBUG || "").toLowerCase());
}

export const log = {
    info(...args) {
        console.log(...format("INFO", COLORS.cyan, args));
    },
    warn(...args) {
        console.warn(...format("WARN", COLORS.yellow, args));
    },
    error(...args) {
        console.error(...format("ERROR", COLORS.red, args));
    },
    debug(...args) {
        if (debugEnabled()) {
            console.debug(...format("DEBUG", COLORS.gray, args));
        }
    },
    ok(...args) {
        console.log(...format("OK", COLORS.green, args));
    },
};
