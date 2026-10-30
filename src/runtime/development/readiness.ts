import { href } from "../../routing";
import type { ReadApplication } from "../application";
import type { BrowserBuild } from "../build/client";
import { describeSchema } from "../schema-wire";

/** Probe admitted routes, assets and transport, including projects with only dynamic routes. */
export async function verifyDevelopmentReadiness(app: ReadApplication, browser: BrowserBuild, origin: URL, signal: AbortSignal = AbortSignal.timeout(60000)): Promise<void> {
  try { await probe(app, browser, origin, signal); }
  catch (error) { if (signal.aborted) throw new Error("READINESS_TIMEOUT"); throw error; }
}
async function probe(app: ReadApplication, browser: BrowserBuild, origin: URL, signal: AbortSignal): Promise<void> {
  const request = (path: string, init: RequestInit = {}) => fetch(new URL(path, origin), { ...init, signal });
  signal.throwIfAborted();
  if (!app.registry.pages.size) throw new Error("SOURCE_REJECTED");
  for (const page of app.registry.pages.values()) {
    const fields = describeSchema(page.params).properties;
    const params = Object.fromEntries(Object.entries(fields ?? {}).map(([name, field]) => {
      const value = field.type === "enum" ? field.values?.find(value => value.length > 0 && value !== "." && value !== "..") : "f".repeat(Math.max(1, Math.min(8192, field.min ?? 1)));
      return [name, value];
    }));
    let path: string;
    try { path = href(page, params); } catch { throw new Error("SOURCE_REJECTED"); }
    if (path.length > 8192) throw new Error("SOURCE_REJECTED");
    let response: Response, html: string;
    for (;;) {
      response = await request(path); html = await response.text();
      const code = !response.ok && response.headers.get("content-type")?.startsWith("application/json") ? (JSON.parse(html) as { error?: { code?: string } }).error?.code : undefined;
      if (code !== "QUERY_TIMEOUT") break;
      // Cold preparation may consume a read's ordinary operation budget. Only
      // read probes retry, within the unchanged whole-readiness deadline.
      signal.throwIfAborted(); await Bun.sleep(100);
    }
    // A data-dependent route may correctly report a declared NOT_FOUND for a
    // valid synthetic key. This still proves server execution, not an invented row.
    const missing = response.status === 404 && JSON.parse(html)?.error?.code === "NOT_FOUND";
    if (!missing && (!response.ok || !html.includes('id="fleur-page"'))) throw new Error("SOURCE_REJECTED", { cause: { probe: "render", status: response.status } });
    if (!missing) {
      const data = html.match(/<script type="application\/json" id="fleur-view">([^<]*)<\/script>/)?.[1];
      const identity: unknown = data ? JSON.parse(data) : null;
      if (!identity || typeof identity !== "object" || !("connection" in identity) || !("page" in identity) || typeof identity.connection !== "string" || typeof identity.page !== "string") throw new Error("SOURCE_REJECTED");
      const retired = await request("/__fleur/view", { method: "POST", headers: { origin: origin.origin, "x-fleur-request": "view", "content-type": "application/json" }, body: JSON.stringify({ action: "dispose", connection: identity.connection, page: identity.page }) });
      if (!retired.ok) throw new Error("SOURCE_REJECTED");
    }
    const view = await request("/__fleur/view", { method: "POST", headers: { origin: origin.origin, "x-fleur-request": "view", "content-type": "application/json" }, body: JSON.stringify({ action: "open", path }) });
    if (missing) {
      if (view.status !== 404 || (await view.json() as { error?: { code?: string } }).error?.code !== "NOT_FOUND") throw new Error("SOURCE_REJECTED");
      continue;
    }
    if (!view.ok) throw new Error("SOURCE_REJECTED");
    const opened = await view.json() as { connection: string; page: string; epoch: string };
    if (!opened.epoch || !opened.connection || !opened.page) throw new Error("SOURCE_REJECTED");
    const disposed = await request("/__fleur/view", { method: "POST", headers: { origin: origin.origin, "x-fleur-request": "view", "content-type": "application/json" }, body: JSON.stringify({ action: "dispose", connection: opened.connection, page: opened.page }) });
    if (!disposed.ok) throw new Error("SOURCE_REJECTED");
  }
  for (const path of browser.files.keys()) if (!(await request(path)).ok) throw new Error("SOURCE_REJECTED");
}
