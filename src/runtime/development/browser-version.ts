import type { BrowserBuild } from "../build/client";

export interface BrowserVersion { readonly marker: string; readonly browser: BrowserBuild }
export function browserVersionHeaders(version: BrowserVersion): Record<string, string> {
  return { "X-Fleur-Development": version.marker, ...(version.browser.module ? { "X-Fleur-Client": version.browser.module } : {}), ...(version.browser.stylesheet ? { "X-Fleur-Stylesheet": version.browser.stylesheet } : {}), ...(version.browser.compatibility ? { "X-Fleur-Client-Compatibility": version.browser.compatibility } : {}), "Cache-Control": "no-store" };
}
/** Stale browser contracts cannot authorize operations in a different generation. */
export function refuseStaleBrowser(request: Request, version: BrowserVersion): Response | null {
  const path = new URL(request.url).pathname;
  if (request.method !== "POST" || !["/__fleur/view", "/__fleur/mutation"].includes(path) || request.headers.get("X-Fleur-Development") === version.marker) return null;
  const headers = browserVersionHeaders(version);
  return Response.json(path === "/__fleur/mutation" ? { status: "failure", error: { code: "SOURCE_CHANGED" } } : { error: { code: "SOURCE_CHANGED" } }, { status: 409, headers });
}
