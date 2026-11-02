import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs/promises";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../../src/media-core/config.js";
import { publicDnsLookup } from "../../src/media-core/utils/security.js";
import { downloadWithGrabfy } from "../../src/media-core/download/engines/grabfy.js";
import { downloadMedia } from "../../src/media-core/download/orchestrator.js";
import { planEngines } from "../../src/media-core/download/planner.js";

const SOURCE = "https://www.instagram.com/p/fixture/";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const payload = (count = 2) => ({
    shortcode: "fixture",
    items: Array.from({ length: count }, (_, index) => ({
        type: "image",
        download: `https://media.example.test/${index + 1}.png`,
    })),
});

async function fixture(t, data = payload(), settings = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-grabfy-"));
    const enabled = config.grabfyEnabled;
    config.grabfyEnabled = true;
    const requests = [];
    t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
    t.mock.method(https, "request", (url, options, callback) => {
        const request = new EventEmitter();
        request.end = (body) =>
            queueMicrotask(() => {
                requests.push({ url: String(url), options, body });
                assert.equal(options.lookup, publicDnsLookup);
                const resolver = options.method === "POST";
                let statusCode = resolver ? (settings.status ?? 200) : 200;
                let headers = resolver ? { "content-type": "application/json" } : { "content-type": "image/png" };
                let bytes = resolver
                    ? Buffer.from(settings.body ?? JSON.stringify(data))
                    : settings.firstVideo && String(url).endsWith("1.png")
                      ? settings.firstVideo
                      : PNG;

                if (!resolver && settings.failSecond && String(url).endsWith("2.png")) statusCode = 503;

                if (!resolver && settings.privateRedirect) {
                    statusCode = 302;
                    headers.location = "http://127.0.0.1/private.png";
                }

                headers["content-length"] = String(bytes.length);
                const response = Readable.from([bytes]);
                Object.assign(response, { statusCode, headers });
                callback(response);
            });

        return request;
    });
    t.after(async () => {
        config.grabfyEnabled = enabled;
        await fs.rm(directory, { recursive: true, force: true });
    });

    return { directory, requests };
}

test("prefers Grabfy only when enabled for Instagram and respects disabled engines", () => {
    const settings = { ...config, grabfyEnabled: true, disabledEngines: new Set(), cobaltApiEndpoints: [] };

    for (const outputType of ["auto", "video", "audio", "image", "thumbnail"]) {
        assert.equal(planEngines(SOURCE, outputType, settings)[0], "grabfy");
    }

    assert.equal(planEngines(SOURCE, "auto", { ...settings, grabfyEnabled: false }).includes("grabfy"), false);
    assert.equal(planEngines(SOURCE, "auto", { ...settings, disabledEngines: new Set(["grabfy"]) }).includes("grabfy"), false);
    assert.equal(planEngines("https://example.com/post", "auto", settings).includes("grabfy"), false);
});

test("downloads all carousel items in order and sends only the canonical source", async (t) => {
    const f = await fixture(t);
    const result = await downloadWithGrabfy(`${SOURCE}?img_index=1&token=secret`, f.directory, { outputType: "auto", maxBytes: 1000 });
    assert.equal(result.items.length, 2);
    assert.deepEqual(
        result.items.map((item) => path.basename(path.dirname(item.filePath))),
        ["item-001", "item-002"],
    );
    const request = f.requests[0];
    assert.equal(request.url, "https://api.grabfy.com/api/resolve");
    assert.deepEqual(JSON.parse(request.body), { url: SOURCE });
    assert.equal(request.options.headers.cookie, undefined);
    assert.equal(request.options.headers.authorization, undefined);
    assert.equal(result.metadata.sourceUrl, SOURCE);
});

test("does not call Grabfy when disabled or given another host or credentials", async (t) => {
    const f = await fixture(t);

    for (const url of [
        "https://example.com/p/fixture/",
        "https://user:password@instagram.com/p/fixture/",
        "https://instagram.com.evil.example/p/fixture/",
        "https://instagram.com/profile/",
    ]) {
        await assert.rejects(downloadWithGrabfy(url, f.directory));
    }

    config.grabfyEnabled = false;
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory));
    assert.equal(f.requests.length, 0);
});

test("rejects a partial album instead of recovering its first image", async (t) => {
    const f = await fixture(t, payload(), { failSecond: true });
    await assert.rejects(
        downloadMedia(SOURCE, f.directory, {
            outputType: "auto",
            plan: ["grabfy"],
            engines: new Map([["grabfy", downloadWithGrabfy]]),
        }),
    );
    assert.equal(f.requests.filter((request) => request.options.method === "GET").length, 2);
});

test("enforces the aggregate transfer budget and collection count", async (t) => {
    const f = await fixture(t);
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory, { maxBytes: PNG.length + 1 }), { code: "FILE_TOO_LARGE" });
    const many = payload(51);
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory, { requestGrabfy: async () => new Response(JSON.stringify(many)) }), {
        code: "COLLECTION_TOO_LARGE",
    });
});

test("rejects private destinations and private redirects even when a caller trusts them", async (t) => {
    const data = payload(1);
    data.items[0].download = "http://127.0.0.1/private.png";
    const f = await fixture(t, data, { privateRedirect: true });
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory, { trustedHosts: ["127.0.0.1"], trustedOrigins: ["http://127.0.0.1"] }), {
        code: "PRIVATE_URL",
    });
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory, { requestGrabfy: async () => new Response(JSON.stringify(payload(1))) }), {
        code: "PRIVATE_URL",
    });
});

test("refuses resolver redirects and bounds JSON without exposing provider text", async (t) => {
    const f = await fixture(t, payload(), { status: 302, body: "secret-token" });
    await assert.rejects(
        downloadWithGrabfy(SOURCE, f.directory),
        (error) => /HTTP 302/.test(error.message) && !error.message.includes("secret-token"),
    );
    await assert.rejects(
        downloadWithGrabfy(SOURCE, f.directory, {
            requestGrabfy: async () => new Response("x".repeat(1024 * 1024 + 1)),
        }),
        /exceeded/,
    );
    await assert.rejects(
        downloadWithGrabfy(SOURCE, f.directory, {
            requestGrabfy: async () => new Response(JSON.stringify({ ...payload(), shortcode: "another" })),
        }),
        /invalid post media/,
    );
});

test("cancels a pending resolver and applies its resolution deadline", async (t) => {
    const f = await fixture(t);
    const keepAlive = setTimeout(() => {}, 1000);
    t.after(() => clearTimeout(keepAlive));
    const requestGrabfy = (_request, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory, { requestGrabfy, grabfyTimeoutMs: 10 }), /timed out/);
    const controller = new AbortController();
    const operation = downloadWithGrabfy(SOURCE, f.directory, { requestGrabfy, signal: controller.signal });
    controller.abort(new Error("fixture cancellation"));
    await assert.rejects(operation, /fixture cancellation/);
});

test("rejects a declared video child that downloads as an image", async (t) => {
    const { checkFFmpeg, runFFmpeg } = await import("../../src/media-core/utils/ffmpeg.js");

    if (!(await checkFFmpeg())) return t.skip("FFmpeg is unavailable.");

    const data = payload();

    for (const item of data.items) item.type = "video";

    const f = await fixture(t, data);
    const video = path.join(f.directory, "fixture.mp4");
    await runFFmpeg(["-f", "lavfi", "-i", "color=c=blue:s=32x32:d=0.1", "-c:v", "libx264", "-y", video]);
    const bytes = await fs.readFile(video);
    const requestGrabfy = async () => new Response(JSON.stringify(data));
    const original = https.request;
    t.mock.method(https, "request", (url, options, callback) =>
        original(url, options, (response) => {
            if (String(url).endsWith("1.png")) {
                const media = Readable.from([bytes]);
                Object.assign(media, { statusCode: 200, headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } });
                callback(media);
            } else callback(response);
        }),
    );
    await assert.rejects(downloadWithGrabfy(SOURCE, f.directory, { outputType: "video", requestGrabfy }), /complete requested media/);
});
