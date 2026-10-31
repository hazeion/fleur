import type { BrowserBuild } from "../build/client";
import { browserVersionHeaders, refuseStaleBrowser } from "./browser-version";

export interface DevelopmentForwardTarget { readonly url: URL; readonly healthURL: URL; readonly browser: BrowserBuild; readonly marker?: string }
/** One admitted public request; ownership and draining remain with the supervisor. */
export async function forwardDevelopmentRequest(request: Request, expected: string, target: DevelopmentForwardTarget, serviceLost: () => Promise<void>, timeoutMs = 30000): Promise<Response> {
  const incoming = new URL(request.url), marker = target.marker;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error("REQUEST_DENIED");
  if (incoming.pathname === target.healthURL.pathname) return new Response(null, { status: 404 });
  const deadline = AbortSignal.timeout(Math.ceil(timeoutMs));
  try {
    const headers = new Headers(request.headers); headers.delete("host");
    const origin = headers.get("origin");
    if (origin && origin !== expected) return new Response(null, { status: 403 });
    const stale = marker === undefined ? undefined : refuseStaleBrowser(request, { marker, browser: target.browser });
    if (stale) return stale;
    if (origin) headers.set("origin", target.url.origin);
    // Assign the parts: resolving "//host/path" against the listener would select that host.
    const upstream = new URL(target.url);
    upstream.pathname = incoming.pathname; upstream.search = incoming.search;
    const response = await fetch(upstream, { method: request.method, headers, ...(["GET", "HEAD"].includes(request.method) ? {} : { body: request.body }), signal: AbortSignal.any([request.signal, deadline]), redirect: "manual" });
    const output = new Headers(response.headers);
    const csp = output.get("content-security-policy");
    if (csp) {
      let policy = csp.replaceAll(target.url.origin, expected);
      // The stable development document must admit a later compiler-owned
      // stylesheet. Application stylesheet injection remains prohibited.
      if (marker !== undefined && target.browser.stylesheet) policy = policy.replace(new URL(target.browser.stylesheet, expected).href, new URL("/assets/", expected).href);
      output.set("content-security-policy", policy);
    }
    // Production has one immutable generation and no development metadata.
    if (marker === undefined) return new Response(await response.arrayBuffer(), { status: response.status, headers: output });
    for (const [name, value] of Object.entries(browserVersionHeaders({ marker, browser: target.browser }))) output.set(name, value);
    const result = new Response(await response.arrayBuffer(), { status: response.status, headers: output });
    return output.get("content-type")?.startsWith("text/html") ? new HTMLRewriter().on("head", { element(element) { element.append(`<meta name="fleur-development" content="${marker}"><meta name="fleur-client-compatibility" content="${target.browser.compatibility ?? ""}">`, { html: true }); } }).transform(result) : result;
  } catch {
    // Neither the caller's upload, a response-body error nor a request deadline
    // proves service loss. Probe the framework listener independently. A probe
    // timeout is still uncertainty; only refused local connection is loss proof.
    let lost = false;
    try {
      const health = await fetch(target.healthURL, { redirect: "error", headers: { connection: "close" }, signal: AbortSignal.timeout(1000) });
      await health.body?.cancel();
    } catch (error) { lost = error instanceof Error && "code" in error && error.code === "ECONNREFUSED"; }
    if (lost) await serviceLost();
    return incoming.pathname === "/__fleur/mutation" ? Response.json({ status: "outcome-unknown" }, { status: 503 }) : Response.json({ error: { code: lost ? "INSTANCE_UNAVAILABLE" : deadline.aborted ? "QUERY_TIMEOUT" : "INTERNAL_FAILURE" } }, { status: 503 });
  }
}
