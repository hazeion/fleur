import { validatePublicValue, type Query, type Retrieval } from "../schema";
import { canonical } from "./canonical";

export interface QueryRefreshResult { readonly status: "success" | "error"; readonly error?: { readonly code: string }; }
export interface QueryState<T> {
  readonly status: "loading" | "success" | "error";
  readonly connection: "connected" | "reconnecting" | "maintenance";
  readonly data?: T; readonly error?: { readonly code: string };
  readonly stale: boolean; readonly refreshing: boolean;
  refresh(): Promise<QueryRefreshResult>;
}
type State = Omit<QueryState<unknown>, "refresh">;
interface Entry { contract: Query; input: unknown; name: string; state: State; listeners: Set<() => void>; }
const names = new WeakMap<object, string>();
const entries = new Map<string, Entry>();
let requestRefresh: ((force?: boolean) => Promise<QueryRefreshResult>) | undefined;
export type RetrievalRefreshResult = QueryRefreshResult;
let requestRetrieval: ((name: string, input: unknown) => Promise<RetrievalRefreshResult>) | undefined;
export function nameQueryExports(exports: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))) if (value && typeof value === "object" && "kind" in value && (value.kind === "query" || value.kind === "retrieval") && !names.has(value)) names.set(value, name);
}
/** Source replacement cannot deliver values validated by a previous contract to new code. */
export function replaceQueryExports(exports: Readonly<Record<string, unknown>>): void {
  nameQueryExports(exports);
  const contracts = new Map<string, Query>();
  for (const value of Object.values(exports)) if (value && typeof value === "object" && "kind" in value && value.kind === "query") {
    const contract = value as Query;
    contracts.set(queryName(contract), contract);
  }
  for (const entry of entries.values()) {
    const contract = contracts.get(entry.name);
    if (contract) entry.contract = contract;
    entry.state = { status: "loading", connection: "reconnecting", stale: true, refreshing: true };
    for (const listener of entry.listeners) listener();
  }
}
export function queryKey(name: string, input: unknown): string {
  validatePublicValue(input);
  return canonical([name, input]);
}
export function queryName(contract: Query | Retrieval): string {
  const name = contract.name ?? names.get(contract);
  if (!name) throw new Error("REQUEST_DENIED");
  return name;
}
export function installQueryRefresh(refresh: (force?: boolean) => Promise<QueryRefreshResult>): void { requestRefresh = refresh; }
export function installRetrievalRefresh(refresh: (name: string, input: unknown) => Promise<RetrievalRefreshResult>): void { requestRetrieval = refresh; }
/** Asks the server view to obtain this retrieval again; the browser never contacts the destination. */
export function refreshRetrievalValue(contract: Retrieval, input: unknown): Promise<RetrievalRefreshResult> {
  const validated = contract.input.parse(input), name = queryName(contract);
  validatePublicValue(validated);
  return requestRetrieval?.(name, validated) ?? Promise.resolve<RetrievalRefreshResult>({ status: "error", error: { code: "NOT_CONNECTED" } });
}
export function activeQueries(): { name: string; input: unknown }[] { return [...entries.values()].map(entry => ({ name: entry.name, input: entry.input })); }
export function observeQuery(contract: Query, input: unknown, listener: () => void) {
  const validated = contract.input.parse(input), name = queryName(contract), key = queryKey(name, validated);
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= 20) throw new Error("QUERY_LIMIT");
    entry = { contract, name, input: validated, listeners: new Set(), state: { status: "loading", connection: "connected", stale: true, refreshing: true } };
    entries.set(key, entry);
  }
  entry.listeners.add(listener);
  queueMicrotask(() => { void requestRefresh?.(); });
  return {
    get: () => structuredClone(entry.state),
    refresh: () => requestRefresh?.(true) ?? Promise.resolve<QueryRefreshResult>({ status: "error", error: { code: "NOT_CONNECTED" } }),
    dispose: () => { entry.listeners.delete(listener); if (!entry.listeners.size) { entries.delete(key); void requestRefresh?.(); } },
  };
}
export function queryConnectionState(status: "reconnecting" | "maintenance" | "refreshing"): void {
  for (const entry of entries.values()) {
    entry.state = { ...entry.state, connection: status === "refreshing" ? entry.state.connection : status, stale: true, refreshing: status === "refreshing" };
    for (const listener of entry.listeners) listener();
  }
}
export function publishQueries(results: readonly { name: string; input: unknown; stale: boolean; status: string; data?: unknown; error?: string }[]): void {
  const prepared: { entry: Entry; state: State }[] = [];
  for (const result of results) {
    const entry = entries.get(queryKey(result.name, result.input));
    if (!entry) continue;
    if (result.status === "loading" || result.status === "refreshing") {
      prepared.push({ entry, state: { connection: "connected", ...(entry.state.data === undefined ? {} : { data: entry.state.data }), status: entry.state.data === undefined ? "loading" : "success", stale: true, refreshing: true } });
    } else if (result.status === "error") {
      prepared.push({ entry, state: { connection: "connected", ...(entry.state.data === undefined ? {} : { data: entry.state.data }), status: "error", stale: true, refreshing: false, error: { code: result.error ?? "INTERNAL_FAILURE" } } });
    } else {
      const data = entry.contract.output.parse(result.data);
      prepared.push({ entry, state: { connection: "connected", data, status: "success", stale: result.stale, refreshing: false } });
    }
  }
  for (const { entry, state } of prepared) { entry.state = state; for (const listener of entry.listeners) listener(); }
}
