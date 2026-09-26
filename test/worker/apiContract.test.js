import assert from "node:assert/strict";
import test from "node:test";
import { parseApiDownloadJob } from "../../src/jobs/api-contract.ts";

test("accepts the API contract v1 and maps it to the runtime job", () => {
    const { payload, runtimeJob } = parseApiDownloadJob({
        contractVersion: 1,
        type: "download",
        jobId: "job_01",
        userId: "usr_01",
        url: "https://example.com/video",
        output: { type: "video", format: "mp4", quality: "720p", maxBytes: 500_000_000, allowCompression: true },
        maxDownloadBytes: 500_000_000,
    });
    assert.equal(payload.contractVersion, 1);
    assert.deepEqual(runtimeJob, {
        type: "download",
        jobId: "job_01",
        url: "https://example.com/video",
        delivery: "private",
        output: { type: "video", format: "mp4", quality: "720p", maxBytes: 500_000_000, allowCompression: true },
        maxDownloadBytes: 500_000_000,
    });
});

test("rejects unknown API contract versions", () => {
    assert.throws(
        () =>
            parseApiDownloadJob({
                contractVersion: 2,
                type: "download",
                jobId: "job_01",
                userId: null,
                url: "https://example.com/video",
                output: {},
                maxDownloadBytes: 20_000_000,
            }),
        /contractVersion/,
    );
});

test("preserves a public delivery request for the storage adapter", () => {
    const { runtimeJob } = parseApiDownloadJob({
        contractVersion: 1,
        type: "download",
        jobId: "job_public",
        userId: "usr_01",
        url: "https://example.com/video",
        delivery: "public",
        output: {},
        maxDownloadBytes: 50_000_000,
    });
    assert.equal(runtimeJob.delivery, "public");
    assert.equal(runtimeJob.output.maxBytes, undefined);
    assert.equal(runtimeJob.output.allowCompression, false);
});
