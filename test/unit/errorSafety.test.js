import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitive, isRetryableError } from "../../src/media-core/utils/errors.js";
import { childEnvironment } from "../../src/media-core/utils/process.js";

test("redacts URL credentials, signed queries, fragments and authentication headers", () => {
    const message =
        "failed https://alice:secret@example.com/video?token=signed-secret#private\nAuthorization: Api-Key operator-secret\nCookie: session=cookie-secret\nBearer bearer-secret";
    const redacted = redactSensitive(message);
    for (const secret of ["alice", "signed-secret", "operator-secret", "cookie-secret", "bearer-secret", "#private"])
        assert.equal(redacted.includes(secret), false);
    assert.match(redacted, /example.com\/video/);
});

test("child environment excludes worker credentials and clears proxy exclusions", () => {
    const env = childEnvironment("http://worker:test@127.0.0.1:1234", {
        R2_SECRET_ACCESS_KEY: "storage-secret",
        REDIS_URL: "redis://user:secret@host",
        NO_PROXY: "*",
        PATH: "/usr/bin",
    });
    assert.equal(env.R2_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.REDIS_URL, undefined);
    assert.equal(env.NO_PROXY, "");
    assert.equal(env.HTTPS_PROXY, "http://worker:test@127.0.0.1:1234");
});

test("classification keeps infrastructure failures retryable and policy failures permanent", () => {
    assert.equal(isRetryableError(Object.assign(new Error("Redis unavailable"), { code: "CONTROL_UNAVAILABLE" })), true);
    assert.equal(isRetryableError(Object.assign(new Error("shutting down"), { code: "WORKER_SHUTDOWN" })), true);
    assert.equal(isRetryableError(Object.assign(new Error("disk limit"), { code: "TEMP_LIMIT" })), false);
    assert.equal(isRetryableError(Object.assign(new Error("cancelled"), { code: "JOB_CANCELLED" })), false);
});
