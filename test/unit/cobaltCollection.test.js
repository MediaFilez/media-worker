import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../../src/media-core/config.js";
import { downloadWithCobalt, resetCobaltEndpointHealth } from "../../src/media-core/download/engines/cobalt.js";
import { downloadMedia } from "../../src/media-core/download/orchestrator.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

for (const scenario of ["complete", "failed-child", "aggregate-limit", "default-limit", "count-limit"]) {
    test(`Cobalt Instagram picker handles ${scenario} without truncating an album`, async (t) => {
        const transfers = [];
        const server = http.createServer((request, response) => {
            if (request.method === "POST") {
                const count = scenario === "count-limit" ? 51 : 2;
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        status: "picker",
                        picker: Array.from({ length: count }, (_, index) => ({
                            type: "photo",
                            url: `http://127.0.0.1:${server.address().port}/${index + 1}.png`,
                        })),
                    }),
                );

                return;
            }

            transfers.push(request.url);

            if (scenario === "failed-child" && request.url === "/2.png") {
                response.writeHead(503).end();

                return;
            }

            response.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
            response.end(PNG);
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mediafilez-cobalt-collection-"));
        const endpoints = config.cobaltApiEndpoints;
        const discovery = config.cobaltDirectoryEnabled;
        const maxDownloadBytes = config.maxDownloadBytes;

        if (scenario === "default-limit") config.maxDownloadBytes = PNG.length + 1;

        config.cobaltApiEndpoints = [`http://127.0.0.1:${server.address().port}/`];
        config.cobaltDirectoryEnabled = false;
        resetCobaltEndpointHealth();
        t.after(async () => {
            config.cobaltApiEndpoints = endpoints;
            config.cobaltDirectoryEnabled = discovery;
            config.maxDownloadBytes = maxDownloadBytes;
            resetCobaltEndpointHealth();
            await new Promise((resolve) => server.close(resolve));
            await fs.rm(directory, { recursive: true, force: true });
        });

        const download = scenario === "default-limit" ? downloadWithCobalt : downloadMedia;
        const operation = download("https://www.instagram.com/p/fixture/", directory, {
            outputType: "auto",
            maxBytes: scenario === "default-limit" ? undefined : scenario === "aggregate-limit" ? PNG.length + 1 : 1024 * 1024,
            plan: ["cobalt"],
            engines: new Map([["cobalt", downloadWithCobalt]]),
        });

        if (scenario === "complete") {
            const result = await operation;
            assert.equal(result.items?.length, 2);
            assert.deepEqual(
                result.items.map((item) => item.mediaKind),
                ["image", "image"],
            );
            assert.deepEqual(transfers, ["/1.png", "/2.png"]);
        } else {
            await assert.rejects(operation);

            if (scenario === "count-limit") assert.deepEqual(transfers, []);

            if (scenario === "failed-child") assert.deepEqual(transfers, ["/1.png", "/2.png"]);
        }
    });
}
