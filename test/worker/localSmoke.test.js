import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkerRuntime } from "../../src/runtime.ts";
import { createMediaCore } from "../../src/media-core/index.ts";
import { LocalStorageAdapter } from "../../src/storage/local.ts";
import { downloadMedia } from "../../src/media-core/download/orchestrator.js";
import { downloadDirectHttp } from "../../src/media-core/download/engines/directHttp.js";
import { checkFFmpeg, getMediaInfo, runFFmpeg } from "../../src/media-core/utils/ffmpeg.js";

test("streams local video through validation, audio-only processing, storage and cleanup", async (t) => {
    if (!(await checkFFmpeg())) return t.skip("FFmpeg is not installed.");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-smoke-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source.mp4");
    await runFFmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x64:d=0.2",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        source,
    ]);
    const bytes = await fs.readFile(source);
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "video/mp4", "content-length": bytes.length });
        response.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    // Only the input DNS assertion is stubbed. The transfer uses an explicitly trusted loopback fixture.
    t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
    const core = createMediaCore();
    core.downloadMedia = async (url, directory, options) =>
        downloadMedia(url, directory, {
            ...options,
            onStatus: options.onProgress,
            plan: ["fixture-http"],
            engines: new Map([
                [
                    "fixture-http",
                    (_url, attemptDir, transferOptions) =>
                        downloadDirectHttp(`http://127.0.0.1:${server.address().port}/clip.mp4`, attemptDir, {
                            ...transferOptions,
                            trustedHosts: ["127.0.0.1"],
                        }),
                ],
            ]),
        });
    const tempRoot = path.join(root, "temp");
    const storage = new LocalStorageAdapter(path.join(root, "stored"));
    const runtime = new WorkerRuntime({ core, storage, tempRoot, maxAttempts: 1 });
    const phases = [];
    const result = await runtime.execute(
        {
            type: "download",
            jobId: "local_smoke",
            url: "https://source.example/clip.mp4",
            maxDownloadBytes: 1024 * 1024,
            output: { quality: "audio-only", format: "mp3" },
        },
        { onProgress: (update) => phases.push(update.phase) },
    );
    const info = await getMediaInfo(result.output.location);
    assert.equal(info.hasAudio, true);
    assert.equal(info.hasVideo, false);
    assert.equal(result.output.contentType, "audio/mpeg");
    assert.ok(phases.includes("downloading") && phases.includes("processing") && phases.includes("completed"));
    assert.deepEqual(await fs.readdir(tempRoot), []);
    assert.equal((await fs.stat(result.output.location)).size, result.output.sizeBytes);
});
