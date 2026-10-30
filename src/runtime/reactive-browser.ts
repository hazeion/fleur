import { activeQueries, installQueryRefresh, installRetrievalRefresh, publishQueries, queryConnectionState, queryKey, type QueryRefreshResult } from "./query-client";
import { viewIdentity, viewResponse, type ViewIdentity } from "./reactive-wire";
import { validatePublicValue } from "../schema";
import { reactiveSend, replaceStylesheet, setDevelopmentGeneration } from "./browser-transport";
import type { PageResult } from "./worker-execution";

async function boundedJSON(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body) throw new Error("Invalid refresh response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 24 * 1048576) throw new Error("Refresh response too large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function startReactiveView(raw: unknown, reconcile: (page: PageResult) => void, replace?: (path: string) => Promise<() => void>): void {
  let reloadRequired = false, pendingDevelopment: string | undefined;
  const compatibility = document.head.querySelector<HTMLMetaElement>('meta[name="fleur-client-compatibility"]')?.content;
  let activate: (() => void) | undefined;
  let stylesheet: string | null = null;
  let development = document.head.querySelector<HTMLMetaElement>('meta[name="fleur-development"]')?.content;
  let identity: ViewIdentity = viewIdentity.parse(raw);
  let generation = identity.generation, sequence = identity.sequence;
  let current = true, force = false, reopen = false, pending = false, trailing = false;
  let active: Promise<QueryRefreshResult> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: AbortController | undefined;
  // Explicit external refreshes wait for the next view refresh request.
  const retrievals = new Map<string, { name: string; input: unknown; waiters: ((result: QueryRefreshResult) => void)[] }>();
  const regions = (state: string) => {
    document.documentElement.dataset.fleurRefresh = state;
    for (const region of document.querySelectorAll("[data-fleur-region]")) region.setAttribute("data-fleur-stale", state === "current" && !region.hasAttribute("data-fleur-error") ? "false" : "true");
    const status = document.getElementById("fleur-refresh-status");
    if (status) status.textContent = state === "reload-required" ? "Application source changed. Your draft is retained. Navigate or reload explicitly to use the new version." : state === "maintenance" ? "Database maintenance is in progress." : state === "reconnecting" ? "Reconnecting. Displayed data may be stale." : state === "error" || document.querySelector("[data-fleur-error]:not([data-fleur-error='QUERY_PENDING'])") ? "Some data is unavailable." : state === "refreshing" || document.querySelector("[data-fleur-error='QUERY_PENDING']") ? "Refreshing stored data." : "";
  };
  const refresh = (): Promise<QueryRefreshResult> => {
    if (!current) return Promise.resolve({ status: "error", error: { code: "NOT_CONNECTED" } });
    if (pending) { trailing = true; return active!; }
    clearTimeout(timer); pending = true;
    const sent = { connection: identity.connection, page: identity.page, generation, sequence: ++sequence };
    const refreshAll = force;
    force = false;
    const asked = reopen ? [] : [...retrievals.values()].slice(0, 20);
    for (const item of asked) retrievals.delete(queryKey(item.name, item.input));
    const answer = (result: (item: (typeof asked)[number]) => QueryRefreshResult) => { for (const item of asked) for (const waiter of item.waiters) waiter(result(item)); };
    abort = new AbortController();
    // A retrieval refresh may use the server's whole external deadline.
    const deadline = setTimeout(() => abort?.abort(), asked.length ? 45_000 : 15_000);
    active = (async (): Promise<QueryRefreshResult> => {
      try {
        const response = await reactiveSend("/__fleur/view", { method: "POST", headers: { "Content-Type": "application/json", "X-Fleur-Request": "view" }, credentials: "same-origin", redirect: "error", cache: "no-store", signal: abort!.signal,
          body: JSON.stringify(reopen ? { action: "open", path: location.pathname } : { action: "refresh", ...sent, force: refreshAll, queries: activeQueries(), ...(asked.length ? { retrievals: asked.map(({ name, input }) => ({ name, input })) } : {}) }) }, pendingDevelopment);
        const delivered = response.headers.get("X-Fleur-Development");
        if (development && delivered && (pendingDevelopment ?? development) !== delivered) {
          const nextCompatibility = response.headers.get("X-Fleur-Client-Compatibility");
          if (!compatibility || !/^[a-f0-9]{64}$/.test(compatibility) || compatibility !== nextCompatibility) {
            reloadRequired = true; current = false;
            queryConnectionState("reconnecting"); regions("reload-required");
            answer(() => ({ status: "error", error: { code: "RELOAD_REQUIRED" } }));
            return { status: "error", error: { code: "RELOAD_REQUIRED" } };
          }
          const module = response.headers.get("X-Fleur-Client");
          if (!replace || !module || !/^\/assets\/client-[a-zA-Z0-9_-]+\.js$/.test(module)) throw new Error("SOURCE_CHANGED");
          activate = await replace(module);
          pendingDevelopment = delivered;
          stylesheet = response.headers.get("X-Fleur-Stylesheet");
          // A different owner has no authority over the previous view identity.
          // Reopen once; discard this response instead of applying stale results.
          reopen = true; generation++; force = true; trailing = true;
          queryConnectionState("reconnecting"); regions("reconnecting");
          answer(() => ({ status: "error", error: { code: "RESPONSE_OBSOLETE" } }));
          return { status: "error", error: { code: "RESPONSE_OBSOLETE" } };
        }
        const rawResult = await boundedJSON(response);
        if (!response.ok) {
          const code = rawResult && typeof rawResult === "object" && "error" in rawResult && rawResult.error && typeof rawResult.error === "object" && "code" in rawResult.error ? String(rawResult.error.code) : "INTERNAL_FAILURE";
          if (code === "CONNECTION_EXPIRED") reopen = true;
          throw new Error(code);
        }
        validatePublicValue(rawResult);
        const result = viewResponse.parse(rawResult);
        if (!current || generation !== sent.generation || sequence !== sent.sequence) { answer(() => ({ status: "error", error: { code: "RESPONSE_OBSOLETE" } })); return { status: "error", error: { code: "RESPONSE_OBSOLETE" } }; }
        if (!reopen && (result.connection !== sent.connection || result.page !== sent.page || result.generation !== sent.generation || result.sequence !== sent.sequence)) throw new Error("RESPONSE_OBSOLETE");
        if (!reopen && result.epoch === identity.epoch && BigInt(result.revision) < BigInt(identity.revision)) throw new Error("RESPONSE_OBSOLETE");
        if (reopen) { generation++; sequence = result.sequence; force = true; trailing = true; }
        identity = viewIdentity.parse({ connection: result.connection, page: result.page, generation: result.generation, sequence: result.sequence, epoch: result.epoch, revision: result.revision, status: result.status });
        reopen = false;
        if (activate) {
          activate(); activate = undefined;
          if (pendingDevelopment) { development = pendingDevelopment; setDevelopmentGeneration(development); pendingDevelopment = undefined; }
          if (stylesheet) replaceStylesheet(stylesheet);
          stylesheet = null;
        }
        // Query schemas validate all results before any island receives new data.
        publishQueries(result.queries);
        reconcile(result.rendered);
        regions(result.renderError ? "error" : result.status);
        if (result.status === "stale") trailing = true;
        answer(item => {
          const outcome = result.retrievals?.find(entry => queryKey(entry.name, entry.input) === queryKey(item.name, item.input));
          return !outcome ? { status: "error", error: { code: "INTERNAL_FAILURE" } } : outcome.status === "current" ? { status: "success" } : { status: "error", error: { code: outcome.error ?? "INTERNAL_FAILURE" } };
        });
        return { status: "success" };
      } catch (error) {
        if (!current) { answer(() => ({ status: "error", error: { code: "NOT_CONNECTED" } })); return { status: "error", error: { code: "NOT_CONNECTED" } }; }
        const code = error instanceof Error ? error.message : "INTERNAL_FAILURE";
        answer(() => ({ status: "error", error: { code } }));
        const maintenance = ["MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SCHEMA_DRIFT", "MIGRATIONS_PENDING"].includes(code);
        queryConnectionState(maintenance ? "maintenance" : "reconnecting");
        regions(maintenance ? "maintenance" : "reconnecting");
        generation++; force = true;
        return { status: "error", error: { code } };
      } finally {
        clearTimeout(deadline); pending = false;
        if (current) { timer = setTimeout(() => { void refresh(); }, trailing ? 0 : 750); trailing = false; }
      }
    })();
    return active;
  };
  installQueryRefresh((requested = false) => {
    force ||= requested;
    if (requested) queryConnectionState("refreshing");
    if (requested && pending) { trailing = true; return active!.then(() => refresh()); }
    return refresh();
  });
  installRetrievalRefresh((name, input) => new Promise<QueryRefreshResult>(resolve => {
    const key = queryKey(name, input);
    const entry = retrievals.get(key) ?? { name, input, waiters: [] };
    entry.waiters.push(resolve);
    retrievals.set(key, entry);
    if (pending) trailing = true;
    else void refresh();
  }));
  window.addEventListener("offline", () => { if (reloadRequired) return; generation++; force = true; abort?.abort(); queryConnectionState("reconnecting"); regions("reconnecting"); });
  window.addEventListener("online", () => { if (reloadRequired) return; generation++; force = true; void refresh(); });
  window.addEventListener("pagehide", () => {
    current = false; clearTimeout(timer); abort?.abort();
    void reactiveSend("/__fleur/view", { method: "POST", headers: { "Content-Type": "application/json", "X-Fleur-Request": "view" }, credentials: "same-origin", keepalive: true, body: JSON.stringify({ action: "dispose", connection: identity.connection, page: identity.page }) }).catch(() => {});
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted || reloadRequired) return;
    current = true; generation++; force = true; reopen = true;
    queryConnectionState("reconnecting"); regions("reconnecting"); void refresh();
  });
  regions(identity.status);
  void refresh();
}
