import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config, MB } from "../../src/media-core/config.js";
import {
    cobaltRequestPayload,
    cobaltRequestHeaders,
    downloadWithCobalt,
    readBoundedJsonResponse,
    resetCobaltEndpointHealth,
    selectCobaltDirectoryEndpoints,
} from "../../src/media-core/download/engines/cobalt.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("caps Cobalt video quality for small upload targets", () => {
    assert.equal(cobaltRequestPayload("https://example.com/video", "auto", 10 * MB).videoQuality, "360");
    assert.equal(cobaltRequestPayload("https://example.com/video", "video", 50 * MB).videoQuality, "480");
    assert.equal(cobaltRequestPayload("https://example.com/video", "video", 100 * MB).videoQuality, "720");
    assert.equal(cobaltRequestPayload("https://example.com/video", "video", 500 * MB).videoQuality, "max");
    assert.equal(cobaltRequestPayload("https://example.com/audio", "audio", 10 * MB).videoQuality, "max");
});

test("selects Cobalt directory endpoints that passed tests for the requested service", () => {
    const response = {
        data: {
            Instagram: ["https://instagram-cobalt.example"],
            Pinterest: ["https://pinterest-cobalt.example"],
            "YouTube Shorts": ["https://youtube-cobalt.example"],
        },
    };

    assert.deepEqual(selectCobaltDirectoryEndpoints(response, "https://www.instagram.com/reel/example/"), ["https://instagram-cobalt.example"]);
    assert.deepEqual(selectCobaltDirectoryEndpoints(response, "https://youtu.be/example"), ["https://youtube-cobalt.example"]);
});

test("ignores protected, offline, and failing instances in detailed directory data", () => {
    const response = {
        data: [
            { api: "protected.example", turnstile: true, tests: { Instagram: { status: true } } },
            { api: "offline.example", online: false, tests: { Instagram: { status: true } } },
            { api: "failed.example", tests: { Instagram: { status: false } } },
            { api: "working.example", tests: { Instagram: { status: true } } },
        ],
    };

    assert.deepEqual(selectCobaltDirectoryEndpoints(response, "https://instagram.com/p/example/"), ["https://working.example"]);
});

test("sends the Cobalt API key only to operator-configured endpoints", (t) => {
    const previousKey = config.cobaltApiKey;
    const previousScheme = config.cobaltAuthScheme;
    config.cobaltApiKey = "operator-secret";
    config.cobaltAuthScheme = "Api-Key";
    t.after(() => {
        config.cobaltApiKey = previousKey;
        config.cobaltAuthScheme = previousScheme;
    });

    assert.equal(cobaltRequestHeaders(true).authorization, "Api-Key operator-secret");
    assert.equal(cobaltRequestHeaders(false).authorization, undefined);
});

test("rejects declared and streamed oversized Cobalt JSON", async () => {
    await assert.rejects(
        readBoundedJsonResponse(new Response("{}", { headers: { "content-length": "1025" } }), 1024, "cobalt"),
        /exceeded 1024 bytes/,
    );

    await assert.rejects(readBoundedJsonResponse(new Response(Buffer.alloc(1025)), 1024, "cobalt"), /exceeded 1024 bytes/);
});

test("does not trust private endpoints supplied by the Cobalt directory", async (t) => {
    resetCobaltEndpointHealth();
    t.after(resetCobaltEndpointHealth);
    let processingRequests = 0;
    const server = http.createServer((request, response) => {
        if (request.url === "/directory") {
            const endpoint = `http://127.0.0.1:${server.address().port}/process`;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: { Instagram: [endpoint] } }));
            return;
        }
        processingRequests += 1;
        response.writeHead(500).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const previousEndpoints = config.cobaltApiEndpoints;
    const previousDirectory = config.cobaltDirectoryEnabled;
    const previousDirectoryUrl = config.cobaltDirectoryUrl;
    config.cobaltApiEndpoints = [];
    config.cobaltDirectoryEnabled = true;
    config.cobaltDirectoryUrl = `http://127.0.0.1:${server.address().port}/directory`;
    t.after(() => {
        config.cobaltApiEndpoints = previousEndpoints;
        config.cobaltDirectoryEnabled = previousDirectory;
        config.cobaltDirectoryUrl = previousDirectoryUrl;
    });

    const attemptDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cobalt-"));
    t.after(() => fs.rm(attemptDir, { recursive: true, force: true }));
    await assert.rejects(
        downloadWithCobalt("https://instagram.com/p/example/", attemptDir, {
            outputType: "image",
            maxBytes: 1024 * 1024,
        }),
        /non-public endpoint/,
    );
    assert.equal(processingRequests, 0);
});

test("rechecks directory endpoint DNS when opening the socket", async (t) => {
    resetCobaltEndpointHealth();
    t.after(resetCobaltEndpointHealth);
    let processingRequests = 0;
    const server = http.createServer((request, response) => {
        if (request.url === "/directory") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    data: { Instagram: [`http://rebind.example:${server.address().port}/process`] },
                }),
            );
            return;
        }
        processingRequests += 1;
        response.writeHead(500).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const originalLookup = dns.lookup;
    const originalPromiseLookup = dns.promises.lookup;
    dns.promises.lookup = async (hostname, options) =>
        hostname === "rebind.example" ? [{ address: "93.184.216.34", family: 4 }] : await originalPromiseLookup(hostname, options);
    dns.lookup = (hostname, options, callback) => {
        if (hostname === "rebind.example") {
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
            return;
        }
        originalLookup(hostname, options, callback);
    };
    t.after(() => {
        dns.lookup = originalLookup;
        dns.promises.lookup = originalPromiseLookup;
    });

    const previousEndpoints = config.cobaltApiEndpoints;
    const previousDirectory = config.cobaltDirectoryEnabled;
    const previousDirectoryUrl = config.cobaltDirectoryUrl;
    config.cobaltApiEndpoints = [];
    config.cobaltDirectoryEnabled = true;
    config.cobaltDirectoryUrl = `http://127.0.0.1:${server.address().port}/directory`;
    t.after(() => {
        config.cobaltApiEndpoints = previousEndpoints;
        config.cobaltDirectoryEnabled = previousDirectory;
        config.cobaltDirectoryUrl = previousDirectoryUrl;
    });

    const attemptDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cobalt-"));
    t.after(() => fs.rm(attemptDir, { recursive: true, force: true }));
    await assert.rejects(
        downloadWithCobalt("https://instagram.com/p/example/", attemptDir, {
            outputType: "image",
            maxBytes: 1024 * 1024,
        }),
        /private or reserved address/,
    );
    assert.equal(processingRequests, 0);
});

test("downloads a Cobalt tunnel from a configured private instance", async (t) => {
    resetCobaltEndpointHealth();
    t.after(resetCobaltEndpointHealth);
    const requests = [];
    const server = http.createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.method === "POST") {
            const base = `http://127.0.0.1:${server.address().port}`;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    status: "tunnel",
                    url: `${base}/media.png`,
                    filename: "cobalt.png",
                    metadata: { title: "Fixture", artist: "Test" },
                }),
            );
            return;
        }
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        response.end(PNG);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const attemptDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cobalt-"));
    t.after(() => fs.rm(attemptDir, { recursive: true, force: true }));
    const previousEndpoints = config.cobaltApiEndpoints;
    const previousDirectory = config.cobaltDirectoryEnabled;
    config.cobaltApiEndpoints = [`http://127.0.0.1:${server.address().port}`];
    config.cobaltDirectoryEnabled = false;
    t.after(() => {
        config.cobaltApiEndpoints = previousEndpoints;
        config.cobaltDirectoryEnabled = previousDirectory;
    });

    const result = await downloadWithCobalt("https://example.com/post", attemptDir, {
        outputType: "image",
        maxBytes: 1024 * 1024,
    });

    assert.equal(result.fileName, "cobalt.png");
    assert.equal(result.metadata.title, "Fixture");
    assert.deepEqual(requests, ["POST /", "GET /media.png"]);
});

test("cools down a failed Cobalt endpoint while another endpoint works", async (t) => {
    resetCobaltEndpointHealth();
    t.after(resetCobaltEndpointHealth);
    let failedRequests = 0;
    let workingRequests = 0;
    const failed = http.createServer((request, response) => {
        failedRequests += 1;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "error", error: { code: "api.fetch.fail" } }));
    });
    const working = http.createServer((request, response) => {
        workingRequests += 1;
        if (request.method === "POST") {
            const base = `http://127.0.0.1:${working.address().port}`;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ status: "tunnel", url: `${base}/media.png`, filename: "result.png" }));
            return;
        }
        response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
        response.end(PNG);
    });
    await Promise.all([
        new Promise((resolve) => failed.listen(0, "127.0.0.1", resolve)),
        new Promise((resolve) => working.listen(0, "127.0.0.1", resolve)),
    ]);
    t.after(() => Promise.all([new Promise((resolve) => failed.close(resolve)), new Promise((resolve) => working.close(resolve))]));

    const previousEndpoints = config.cobaltApiEndpoints;
    const previousDirectory = config.cobaltDirectoryEnabled;
    config.cobaltApiEndpoints = [`http://127.0.0.1:${failed.address().port}`, `http://127.0.0.1:${working.address().port}`];
    config.cobaltDirectoryEnabled = false;
    t.after(() => {
        config.cobaltApiEndpoints = previousEndpoints;
        config.cobaltDirectoryEnabled = previousDirectory;
    });

    for (let index = 0; index < 2; index += 1) {
        const attemptDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cobalt-"));
        t.after(() => fs.rm(attemptDir, { recursive: true, force: true }));
        const result = await downloadWithCobalt("https://example.com/post", attemptDir, {
            outputType: "image",
            maxBytes: 1024 * 1024,
        });
        assert.equal(result.fileName, "result.png");
    }

    assert.equal(failedRequests, 1);
    assert.equal(workingRequests, 4);
});

test("keeps a healthy primary Cobalt endpoint ahead of its fallback", async (t) => {
    resetCobaltEndpointHealth();
    t.after(resetCobaltEndpointHealth);
    let primaryRequests = 0;
    let fallbackRequests = 0;

    function workingServer(increment) {
        return http.createServer((request, response) => {
            increment();
            if (request.method === "POST") {
                const base = `http://127.0.0.1:${request.headers.host.split(":")[1]}`;
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ status: "tunnel", url: `${base}/media.png`, filename: "result.png" }));
                return;
            }
            response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
            response.end(PNG);
        });
    }

    const primary = workingServer(() => {
        primaryRequests += 1;
    });
    const fallback = workingServer(() => {
        fallbackRequests += 1;
    });
    await Promise.all([
        new Promise((resolve) => primary.listen(0, "127.0.0.1", resolve)),
        new Promise((resolve) => fallback.listen(0, "127.0.0.1", resolve)),
    ]);
    t.after(() => Promise.all([new Promise((resolve) => primary.close(resolve)), new Promise((resolve) => fallback.close(resolve))]));

    const previousEndpoints = config.cobaltApiEndpoints;
    const previousDirectory = config.cobaltDirectoryEnabled;
    config.cobaltApiEndpoints = [`http://127.0.0.1:${primary.address().port}`, `http://127.0.0.1:${fallback.address().port}`];
    config.cobaltDirectoryEnabled = false;
    t.after(() => {
        config.cobaltApiEndpoints = previousEndpoints;
        config.cobaltDirectoryEnabled = previousDirectory;
    });

    for (let index = 0; index < 2; index += 1) {
        const attemptDir = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cobalt-"));
        t.after(() => fs.rm(attemptDir, { recursive: true, force: true }));
        await downloadWithCobalt("https://example.com/post", attemptDir, {
            outputType: "image",
            maxBytes: 1024 * 1024,
        });
    }

    assert.equal(primaryRequests, 4);
    assert.equal(fallbackRequests, 0);
});
