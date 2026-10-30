import { expect, test } from "bun:test";
import { createServer, type ServerResponse } from "node:http";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { forwardDevelopmentRequest } from "../../src/runtime/development/forwarding";

async function observed(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("HTTP fixture did not reach its bounded barrier")), 5000); })]); }
  finally { clearTimeout(timer); }
}

// Real HTTP operation evidence. No Docker, database, Doctor or public CLI gate.
for (const fault of ["upload-disconnect", "response-disconnect", "deadline", "uncertain-health", "mutation-response-disconnect", "service-loss"] as const) test(`development forwarding isolates ${fault} and preserves truthful service state`, async () => {
  for (let repeat = 0; repeat < 2; repeat++) {
    let entered!: () => void, finished!: () => void, bodyOpened!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }), finishing = new Promise<void>(resolve => { finished = resolve; }), openingBody = new Promise<void>(resolve => { bodyOpened = resolve; });
    let broken: ServerResponse | undefined, state = "ready", lost = 0, submissions = 0;
    const upstream = createServer(async (request, response) => {
      if (request.url === "/__fleur/health/test-only") { if (fault !== "uncertain-health") response.writeHead(204).end(); return; }
      if (request.url === "/broken" || request.url === "/__fleur/mutation" && fault === "mutation-response-disconnect") { if (request.url === "/__fleur/mutation") submissions++; broken = response; response.writeHead(200, { "Content-Length": "128" }); response.write("partial"); bodyOpened(); return; }
      if (request.url === "/slow") return;
      if (request.url === "/__fleur/mutation") {
        submissions++;
        try { for await (const chunk of request) { void chunk; /* Drain only this disposable HTTP request. */ } response.end("accepted"); } catch { /* A disconnected upload is not a service crash. */ }
        return;
      }
      response.end("healthy sibling");
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("No disposable listener");
    const url = new URL(`http://127.0.0.1:${address.port}`), healthURL = new URL("/__fleur/health/test-only", url);
    let gateway: ReturnType<typeof Bun.serve> | undefined, socket: Socket | undefined;
    try {
      gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/status") return Response.json({ state });
        if (state === "failed") return new Response(null, { status: 503 });
        const isFault = path !== "/";
        if (isFault) entered();
        try { return await forwardDevelopmentRequest(request, gateway!.url.origin, { url, healthURL, marker: "owner:1", browser: { entry: "/assets/test.js", files: new Map() } }, async () => { lost++; state = "failed"; }, fault === "deadline" ? 50 : 5000); }
        finally { if (isFault) finished(); }
      } });
      if (fault === "upload-disconnect") {
        socket = createConnection({ host: "127.0.0.1", port: gateway.port! }); await once(socket, "connect");
        socket.write(`POST /__fleur/mutation HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nX-Fleur-Development: owner:1\r\nTransfer-Encoding: chunked\r\nContent-Type: application/octet-stream\r\n\r\n4\r\nbody\r\n`);
        await observed(entering);
        expect(await (await fetch(gateway.url)).text()).toBe("healthy sibling");
        socket.destroy(); await observed(finishing);
      } else {
        if (fault === "service-loss") { upstream.closeAllConnections(); upstream.close(); await once(upstream, "close"); }
        const disconnectedBody = ["response-disconnect", "uncertain-health", "mutation-response-disconnect"].includes(fault);
        const response = fetch(new URL(fault === "mutation-response-disconnect" ? "/__fleur/mutation" : disconnectedBody ? "/broken" : fault === "deadline" ? "/slow" : "/gone", gateway.url), fault === "mutation-response-disconnect" ? { method: "POST", headers: { "X-Fleur-Development": "owner:1" }, body: "{}" } : {});
        if (disconnectedBody) { await observed(openingBody); expect(await (await fetch(gateway.url)).text()).toBe("healthy sibling"); broken!.destroy(); }
        const result = await response;
        expect(result.status).toBe(503);
        if (fault === "deadline") expect(await result.json()).toEqual({ error: { code: "QUERY_TIMEOUT" } });
        if (fault === "mutation-response-disconnect") { expect(await result.json()).toEqual({ status: "outcome-unknown" }); expect(submissions).toBe(1); }
        await observed(finishing);
      }
      const status = await (await fetch(new URL("/status", gateway.url))).json();
      expect(status).toEqual({ state: fault === "service-loss" ? "failed" : "ready" });
      expect(lost).toBe(fault === "service-loss" ? 1 : 0);
      if (fault !== "service-loss") {
        expect((await fetch(new URL(healthURL.pathname, gateway.url))).status).toBe(404);
        expect(await (await fetch(new URL("/__fleur/health/application-page", gateway.url))).text()).toBe("healthy sibling");
      }
      expect(submissions).toBeLessThanOrEqual(1); // Never replay an uncertain upload.
      if (fault === "service-loss") expect((await fetch(gateway.url)).status).toBe(503);
      else expect(await (await fetch(gateway.url)).text()).toBe("healthy sibling");
    } finally {
      socket?.destroy(); broken?.destroy();
      try { await gateway?.stop(true); }
      finally { upstream.closeAllConnections(); if (upstream.listening) { upstream.close(); await once(upstream, "close"); } }
    }
  }
}, 20000);
