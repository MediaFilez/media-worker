import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { config } from "../../src/media-core/config.js";
import { createEngineProxy } from "../../src/media-core/utils/engineProxy.js";
import { runProcess, childEnvironment } from "../../src/media-core/utils/process.js";
import { checkFFmpeg, runFFmpeg } from "../../src/media-core/utils/ffmpeg.js";
import { downloadWithYtDlp } from "../../src/media-core/download/engines/ytDlp.js";
import { validateArtifact } from "../../src/media-core/download/artifact.js";

test("real yt-dlp uses the authenticated proxy for media and rejects a private destination", { timeout: 30_000 }, async (t) => {
    const entry = fileURLToPath(import.meta.resolve("youtube-dl-exec"));
    const binary = path.join(path.dirname(entry), "..", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    if (!(await fs.stat(binary).catch(() => null)) || !(await checkFFmpeg())) return t.skip("Bundled yt-dlp or FFmpeg unavailable.");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mediaworker-native-proxy-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, "source.mp4");
    await runFFmpeg(["-f", "lavfi", "-i", "color=s=64x64:d=0.2", "-c:v", "libx264", "-y", source]);
    const bytes = await fs.readFile(source);
    let requests = 0;
    const server = http.createServer((_req, res) => {
        requests++;
        res.writeHead(200, { "content-type": "video/mp4", "content-length": bytes.length });
        res.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    const url = `http://127.0.0.1:${server.address().port}/source.mp4`;
    const proxy = await createEngineProxy({ trustedHosts: ["127.0.0.1"] });
    t.after(() => proxy.close());
    const output = path.join(root, "downloaded.mp4");
    await runProcess(binary, ["--ignore-config", "--proxy", proxy.url, "--no-playlist", "-f", "b", "-o", output, "--", url], {
        timeoutMs: 15_000,
        env: childEnvironment(proxy.url),
    });
    const verified = await validateArtifact(output, { outputType: "video" });
    assert.equal(verified.mediaKind, "video");
    assert.ok(requests > 0);
    const before = requests;
    const settings = {
        mediaCookiesFile: config.mediaCookiesFile,
        ytdlpCookiesFromBrowser: config.ytdlpCookiesFromBrowser,
        ytdlpPath: config.ytdlpPath,
    };
    Object.assign(config, { mediaCookiesFile: null, ytdlpCookiesFromBrowser: null, ytdlpPath: binary });
    t.after(() => Object.assign(config, settings));
    const attempt = path.join(root, "blocked");
    await fs.mkdir(attempt);
    await assert.rejects(downloadWithYtDlp(url, attempt, { outputType: "video", maxBytes: 1024 * 1024, signal: AbortSignal.timeout(15_000) }), {
        code: "PRIVATE_URL",
    });
    assert.equal(requests, before);
});
