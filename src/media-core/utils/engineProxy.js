import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { assertPublicHttpUrl, isBlockedAddress, abortableLookup } from "./security.js";
import { userError } from "./errors.js";

// Enforces destination policy for proxy-aware extractors. OS isolation is still required to prevent proxy bypass.
export async function createEngineProxy(options = {}) {
    const controller = new AbortController();
    let closed = false;
    const sockets = new Set();
    const credential = crypto.randomBytes(24).toString("hex");
    const authorization = `Basic ${Buffer.from(`worker:${credential}`).toString("base64")}`;
    const track = (socket) => {
        sockets.add(socket);
        // CONNECT sockets are detached from HTTP's normal error handling. A
        // disconnected extractor can emit EPIPE while upstream is still piping.
        socket.on("error", () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
        return socket;
    };
    async function target(rawUrl) {
        const url = await assertPublicHttpUrl(rawUrl, options);
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const records = net.isIP(host) ? [{ address: host }] : await abortableLookup(host, options.signal);
        if (!records.length || (!(options.trustedHosts ?? []).includes(host) && records.some(({ address }) => isBlockedAddress(address)))) {
            throw userError("Extractor destination is private or reserved.", "PRIVATE_URL", { stopFallback: true });
        }
        options.signal?.throwIfAborted();
        if (closed) throw new Error("Extractor proxy closed.");
        return { url, address: records[0].address };
    }
    function denied(error, response) {
        if (["PRIVATE_URL", "INVALID_URL"].includes(error.code)) controller.abort(error);
        if (response.writeHead) {
            response.writeHead(502);
            response.end("Extractor proxy refused the request.");
        } else response.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    const server = http.createServer(async (request, response) => {
        if (request.headers["proxy-authorization"] !== authorization) {
            response.writeHead(407);
            response.end();
            return;
        }
        try {
            const { url, address } = await target(request.url);
            if (url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS.");
            const headers = { ...request.headers, host: url.host };
            delete headers["proxy-authorization"];
            delete headers["proxy-connection"];
            const outgoing = http.request(
                { hostname: address, port: url.port || 80, path: `${url.pathname}${url.search}`, method: request.method, headers, agent: false },
                (incoming) => {
                    response.writeHead(incoming.statusCode, incoming.headers);
                    void pipeline(incoming, response).catch(() => outgoing.destroy());
                },
            );
            outgoing.once("socket", track);
            outgoing.once("error", (error) => {
                if (!response.headersSent) denied(error, response);
                else response.destroy();
            });
            outgoing.setTimeout(60_000, () => outgoing.destroy());
            void pipeline(request, outgoing).catch(() => outgoing.destroy());
        } catch (error) {
            denied(error, response);
        }
    });
    server.on("connection", track);
    server.maxConnections = 128;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.setTimeout(60_000, (socket) => socket.destroy());
    server.on("connect", async (request, socket, head) => {
        if (request.headers["proxy-authorization"] !== authorization) {
            socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
            return;
        }
        try {
            if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):[0-9]+$/i.test(request.url))
                throw userError("Invalid extractor tunnel destination.", "INVALID_URL", { stopFallback: true });
            const { url, address } = await target(`https://${request.url}/`);
            const upstream = track(net.connect({ host: address, port: Number(url.port || 443) }));
            upstream.setTimeout(60_000, () => upstream.destroy());
            upstream.once("connect", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length) upstream.write(head);
                socket.pipe(upstream);
                upstream.pipe(socket);
            });
            upstream.on("error", () => socket.destroy());
            socket.once("close", () => upstream.destroy());
        } catch (error) {
            denied(error, socket);
        }
    });
    const closeSockets = () => {
        for (const socket of sockets) socket.destroy();
    };
    options.signal?.addEventListener("abort", closeSockets, { once: true });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `http://worker:${credential}@127.0.0.1:${server.address().port}`,
        signal: controller.signal,
        async close() {
            closed = true;
            options.signal?.removeEventListener("abort", closeSockets);
            closeSockets();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

export async function withEngineProxy(signal, callback) {
    signal?.throwIfAborted();
    const proxy = await createEngineProxy({ signal });
    const combined = AbortSignal.any([proxy.signal, ...(signal ? [signal] : [])]);
    try {
        return await callback(proxy.url, combined);
    } catch (error) {
        combined.throwIfAborted();
        throw error;
    } finally {
        await proxy.close();
    }
}
