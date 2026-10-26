import { PublicOperationError } from "../server";
import { randomBytes } from "node:crypto";
import type { ReadApplication } from "./application";
import type { BrowserBuild } from "./build/client";
import { ReactiveProject } from "./reactive-project";
import { viewRequest } from "./reactive-wire";
import type { PageResult } from "./worker-execution";

async function admittedHTML(rendered: PageResult): Promise<void> {
  await new HTMLRewriter().on("iframe,frame,frameset,object,embed,script,portal,fencedframe", { element() { throw new Error("UNSUPPORTED_CAPABILITY"); } }).transform(new Response(rendered.html)).text();
}

/** Loopback fixture/application adapter; lifecycle commands are a later slice. */
export function serveReadApplication(app: ReadApplication, browser: BrowserBuild) {
  app.prepareWorkers();
  const project = new ReactiveProject({
    prepare: () => app.prepareWorkers(),
    revision: () => app.revision(), query: (name, input) => app.query(name, input),
    validate: (name, input) => {
      const query = app.registry.queries.get(name);
      if (!query) throw new Error("REQUEST_DENIED");
      try { return query.input.parse(input); } catch { throw new Error("INPUT_INVALID"); }
    },
    render: async (path, read) => { const result = await app.render(path, read); await admittedHTML(result); return result; },
  });
  // LISTEN is an optimization. Authoritative probes keep running if the
  // notification connection fails or a wakeup is dropped.
  const watching = app.watch(() => { void project.wake(); }).catch(() => undefined);
  let origin = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response("Unrecognized origin", { status: 403 });
    if (url.pathname === "/__fleur/mutation") return mutationResponse(app, request, url);
    if (url.pathname === "/__fleur/view") return viewResponse(project, request, url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const asset = browser.files.get(url.pathname);
    if (asset) return new Response(request.method === "HEAD" ? null : typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer, { headers: { "Content-Type": asset.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable" } });
    try {
      const view = await project.open(url.pathname);
      const rendered = view.rendered;
      // Reject executable embedded documents before the browser parses them.
      await admittedHTML(rendered);
      const nonce = randomBytes(24).toString("base64url");
      const data = JSON.stringify(rendered.islands).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
      const identity = JSON.stringify({ connection: view.connection, page: view.page, generation: view.generation, sequence: view.sequence, epoch: view.epoch, revision: view.revision, status: view.status });
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fleur</title></head><body><div id="fleur-refresh-status" aria-live="polite">${rendered.regions.some(region => region.error) ? "Some data is unavailable." : ""}</div><div id="fleur-page">${rendered.html}</div><script type="application/json" id="fleur-islands">${data}</script><script type="application/json" id="fleur-view">${identity}</script><script type="module" nonce="${nonce}" src="${browser.entry}"></script></body></html>`;
      if (request.method === "HEAD") await project.dispose(view.connection, view.page);
      return new Response(request.method === "HEAD" ? null : html, { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Content-Security-Policy": `sandbox allow-scripts allow-same-origin allow-forms; frame-ancestors 'none'; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-src 'none'; object-src 'none'; form-action 'self'`,
      } });
    } catch (error) {
      if (error instanceof Error && ["MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SCHEMA_DRIFT", "MIGRATIONS_PENDING"].includes(error.message)) return new Response(`<!doctype html><html lang="en"><title>Database maintenance</title><h1>Database maintenance</h1><p>${error.message === "RECOVERY_REQUIRED" ? "Maintenance needs inspection before this application can resume." : "Database maintenance is in progress. Refresh after it completes."}</p></html>`, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      if (error instanceof PublicOperationError) return Response.json({ error: { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) } }, { status: error.code === "NOT_FOUND" ? 404 : error.code === "INPUT_INVALID" ? 400 : error.code.endsWith("CONFLICT") ? 409 : 422, headers: { "Cache-Control": "no-store" } });
      const code = error instanceof Error && ["ROUTE_INVALID", "ROUTE_NOT_FOUND", "QUERY_TIMEOUT", "RESULT_TOO_LARGE"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
      return Response.json({ error: { code } }, { status: code === "ROUTE_NOT_FOUND" ? 404 : code === "ROUTE_INVALID" ? 400 : 500, headers: { "Cache-Control": "no-store" } });
    }
  } });
  origin = server.url.origin;
  const stop = server.stop.bind(server);
  server.stop = async (closeActiveConnections?: boolean) => { const closing = project.close(); await stop(closeActiveConnections); await closing; await (await watching)?.(); };
  return server;
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("INPUT_INVALID");
  const reader = request.body.getReader();
  let expired = false;
  const abort = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 1048576) throw new Error("INPUT_INVALID");
      chunks.push(next.value);
    }
    if (expired) throw new Error("INPUT_INVALID");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { clearTimeout(abort); await reader.cancel().catch(() => {}); }
}
async function viewResponse(project: ReactiveProject, request: Request, url: URL): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const fail = (code: string, status: number) => Response.json({ error: { code } }, { status, headers });
  if (request.method !== "POST") return fail("REQUEST_DENIED", 405);
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-fleur-request") !== "view" || request.headers.get("content-type") !== "application/json") return fail("REQUEST_DENIED", 403);
  let command;
  try { command = viewRequest.parse(await readBody(request)); }
  catch { return fail("INPUT_INVALID", 400); }
  try {
    if (command.action === "dispose") { await project.dispose(command.connection, command.page); return Response.json({ disposed: true }, { headers }); }
    const result = command.action === "open" ? await project.open(command.path) : await project.refresh(command);
    return Response.json(result, { headers });
  } catch (error) {
    const code = error instanceof Error && ["QUERY_LIMIT", "QUERY_TIMEOUT", "RESULT_TOO_LARGE", "INPUT_INVALID", "REQUEST_DENIED", "CONNECTION_EXPIRED", "RESPONSE_OBSOLETE", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "ROUTE_INVALID", "ROUTE_NOT_FOUND"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
    return fail(code, ["MAINTENANCE_BUSY", "RECOVERY_REQUIRED"].includes(code) ? 503 : code === "CONNECTION_EXPIRED" ? 410 : code === "RESPONSE_OBSOLETE" ? 409 : 422);
  }
}

async function mutationResponse(app: ReadApplication, request: Request, url: URL): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  const fail = (code: string, status = 400) => Response.json({ status: "failure", error: { code } }, { status, headers });
  if (request.method !== "POST") return fail("REQUEST_DENIED", 405);
  if (request.headers.get("origin") !== url.origin || request.headers.get("x-fleur-request") !== "mutation" || request.headers.get("content-type") !== "application/json") return fail("REQUEST_DENIED", 403);
  if (!request.body) return fail("INPUT_INVALID");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let raw: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 1048576) throw new Error("Request limit");
          chunks.push(next.value);
        }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Request timeout")), 5000); }),
    ]);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 2 || !("name" in raw) || !("input" in raw) || typeof raw.name !== "string") return fail("INPUT_INVALID");
  } catch { return fail("INPUT_INVALID"); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  const mutation = raw as { name: string; input: unknown };
  try {
    const data = await app.mutate(mutation.name, mutation.input);
    return Response.json({ status: "success", data }, { headers });
  } catch (error) {
    if (error instanceof Error && ["MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SCHEMA_DRIFT", "MIGRATIONS_PENDING"].includes(error.message)) return fail(error.message, 503);
    if (error instanceof PublicOperationError) return Response.json({ status: "failure", error: { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) } }, { status: 422, headers });
    if (error instanceof Error && error.message === "OUTCOME_UNKNOWN") return Response.json({ status: "outcome-unknown" }, { status: 503, headers });
    const code = error instanceof Error && ["REQUEST_DENIED", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
    return fail(code, 500);
  }
}
