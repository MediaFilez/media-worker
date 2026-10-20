import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { publicFetch, withFetchSignal } from "../../src/media-core/utils/publicFetch.js";
import { createEngineProxy } from "../../src/media-core/utils/engineProxy.js";
import { assertPublicHttpUrl, isBlockedAddress } from "../../src/media-core/utils/security.js";

async function fixture(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    return `http://127.0.0.1:${server.address().port}`;
}

async function proxyRequest(proxy, destination, authenticated = true) {
    const url = new URL(proxy.url);
    const response = await new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: url.hostname,
                port: url.port,
                path: destination,
                headers: authenticated ? { "proxy-authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}` } : {},
            },
            resolve,
        );
        request.on("error", reject);
        request.end();
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    return { status: response.statusCode, body: Buffer.concat(chunks).toString() };
}

test("rejects canonical, mapped and transition private IPv6 and URL credentials", async () => {
    for (const address of [
        "0:0:0:0:0:0:0:1",
        "::ffff:127.0.0.1",
        "::ffff:a00:1",
        "2002:0a00:0001::1",
        "2001::1",
        "2001:2::1",
        "64:ff9b::a00:1",
        "3fff::1",
    ]) {
        assert.equal(isBlockedAddress(address), true, address);
    }
    assert.equal(isBlockedAddress("::ffff:1.1.1.1"), false);
    assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
    await assert.rejects(assertPublicHttpUrl("http://[::ffff:7f00:1]/"), { code: "PRIVATE_URL" });
    await assert.rejects(assertPublicHttpUrl("https://user:secret@example.com/"), { code: "INVALID_URL" });
});

test("guarded fetch blocks redirects outside an explicitly trusted fixture origin", async (t) => {
    let privateRequests = 0;
    const privateOrigin = await fixture(t, (_req, res) => {
        privateRequests++;
        res.end("secret");
    });
    const source = await fixture(t, (_req, res) => res.writeHead(302, { location: privateOrigin }).end());
    await assert.rejects(publicFetch(source, {}, { trustedHosts: [], trustedOrigins: [source] }), { code: "PRIVATE_URL" });
    assert.equal(privateRequests, 0);
});

test("guarded fetch rechecks DNS at connection time", async (t) => {
    t.mock.method(dns.promises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
    t.mock.method(dns, "lookup", (_host, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]));
    await assert.rejects(publicFetch("http://rebind.example/"), { code: "PRIVATE_URL", stopFallback: true });
});

test("guarded fetch strips credentials on redirects and limits decoded bytes", async (t) => {
    let headers;
    const destination = await fixture(t, (req, res) => {
        headers = req.headers;
        res.end("okay");
    });
    const source = await fixture(t, (_req, res) => res.writeHead(302, { location: destination }).end());
    const response = await publicFetch(
        source,
        { headers: { authorization: "Bearer test-secret", cookie: "session=secret" } },
        { trustedHosts: ["127.0.0.1"] },
    );
    assert.equal(await response.text(), "okay");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.cookie, undefined);
    const limited = await publicFetch(destination, {}, { trustedHosts: ["127.0.0.1"], maxBytes: 2 });
    await assert.rejects(limited.text(), /byte limit/);
});

test("YouTube fetch context aborts a stalled request", async (t) => {
    const source = await fixture(t, () => {});
    const controller = new AbortController();
    const pending = withFetchSignal(controller.signal, () => publicFetch(source, {}, { trustedHosts: ["127.0.0.1"] }));
    controller.abort(new Error("cancelled fixture"));
    await assert.rejects(pending, /abort|cancelled/i);
});

test("extractor proxy authenticates and permits a normal transfer through the fixture", async (t) => {
    const source = await fixture(t, (_req, res) => res.end("media"));
    const proxy = await createEngineProxy({ trustedHosts: ["127.0.0.1"] });
    t.after(() => proxy.close());
    assert.equal((await proxyRequest(proxy, source, false)).status, 407);
    assert.deepEqual(await proxyRequest(proxy, source), { status: 200, body: "media" });
});

test("a broken CONNECT client socket cannot crash the worker or poison the next request", { timeout: 3000 }, async (t) => {
    const source = await fixture(t, (_req, res) => res.end("still alive"));
    const proxy = await createEngineProxy({ trustedHosts: ["127.0.0.1"] });
    t.after(() => proxy.close());
    const write = net.Socket.prototype.write;
    let injected = false;
    t.mock.method(net.Socket.prototype, "write", function (chunk, ...args) {
        const result = write.call(this, chunk, ...args);
        if (!injected && typeof chunk === "string" && chunk.startsWith("HTTP/1.1 200 Connection Established")) {
            injected = true;
            queueMicrotask(() => this.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
        }
        return result;
    });
    const url = new URL(proxy.url);
    const client = net.connect(Number(url.port), url.hostname);
    client.on("error", () => {});
    t.after(() => client.destroy());
    await once(client, "connect");
    const closed = once(client, "close");
    const destination = new URL(source);
    client.write(
        `CONNECT ${destination.host} HTTP/1.1\r\nHost: ${destination.host}\r\nProxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}\r\n\r\n`,
    );
    client.resume();
    await closed;
    assert.equal(injected, true);
    t.mock.restoreAll();
    assert.deepEqual(await proxyRequest(proxy, source), { status: 200, body: "still alive" });
});

test("extractor proxy blocks internal requests and terminates the engine signal", async (t) => {
    let requests = 0;
    const internal = await fixture(t, (_req, res) => {
        requests++;
        res.end("private");
    });
    const proxy = await createEngineProxy();
    t.after(() => proxy.close());
    assert.equal((await proxyRequest(proxy, internal)).status, 502);
    assert.equal(proxy.signal.reason.code, "PRIVATE_URL");
    assert.equal(requests, 0);
});

test("extractor proxy pins DNS and refuses rebinding before connecting", async (t) => {
    let lookups = 0;
    t.mock.method(dns.promises, "lookup", async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]);
    const proxy = await createEngineProxy();
    t.after(() => proxy.close());
    assert.equal((await proxyRequest(proxy, "http://rebind.example/")).status, 502);
    assert.equal(lookups, 2);
    assert.equal(proxy.signal.reason.code, "PRIVATE_URL");
});

test("extractor proxy refuses CONNECT to private IPv6", async (t) => {
    const proxy = await createEngineProxy();
    t.after(() => proxy.close());
    const url = new URL(proxy.url);
    const socket = net.connect(Number(url.port), url.hostname);
    t.after(() => socket.destroy());
    await once(socket, "connect");
    socket.write(
        `CONNECT [::ffff:7f00:1]:443 HTTP/1.1\r\nHost: [::ffff:7f00:1]:443\r\nProxy-Authorization: Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}\r\n\r\n`,
    );
    const [data] = await once(socket, "data");
    assert.match(data.toString(), /502/);
    assert.equal(proxy.signal.reason.code, "PRIVATE_URL");
});
