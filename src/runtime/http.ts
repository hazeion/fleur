import { PublicOperationError } from "../server";
import { randomBytes } from "node:crypto";
import type { ReadApplication } from "./application";
import type { BrowserBuild } from "./build/client";

/** Loopback read fixture/application adapter; lifecycle commands are a later slice. */
export function serveReadApplication(app: ReadApplication, browser: BrowserBuild) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const asset = browser.files.get(url.pathname);
    if (asset) return new Response(request.method === "HEAD" ? null : typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer, { headers: { "Content-Type": asset.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=31536000, immutable" } });
    try {
      const rendered = await app.render(url.pathname);
      const nonce = randomBytes(24).toString("base64url");
      const data = JSON.stringify(rendered.islands).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fleur</title></head><body>${rendered.html}<script type="application/json" id="fleur-islands">${data}</script><script type="module" nonce="${nonce}" src="${browser.entry}"></script></body></html>`;
      return new Response(request.method === "HEAD" ? null : html, { headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-src 'none'; object-src 'none'; form-action 'self'`,
      } });
    } catch (error) {
      if (error instanceof PublicOperationError) return Response.json({ error: { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) } }, { status: error.code === "NOT_FOUND" ? 404 : error.code === "INPUT_INVALID" ? 400 : error.code.endsWith("CONFLICT") ? 409 : 422, headers: { "Cache-Control": "no-store" } });
      const code = error instanceof Error && ["ROUTE_INVALID", "ROUTE_NOT_FOUND", "QUERY_TIMEOUT", "RESULT_TOO_LARGE"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
      return Response.json({ error: { code } }, { status: code === "ROUTE_NOT_FOUND" ? 404 : code === "ROUTE_INVALID" ? 400 : 500, headers: { "Cache-Control": "no-store" } });
    }
  } });
}
