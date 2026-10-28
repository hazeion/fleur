import { randomUUID } from "node:crypto";
import { validatePublicValue } from "../schema";
import type { DatabaseRevision } from "./database/revision";
import type { PageResult, QueryDependency } from "./worker-execution";
import { canonical } from "./canonical";
import { RetrievalError } from "./retrieval/destinations";
export interface ReactiveBackend {
  prepare?(): void;
  revision(): Promise<DatabaseRevision>;
  validate(name: string, input: unknown): unknown;
  query(name: string, input: unknown): Promise<unknown>;
  validateRetrieval?(name: string, input: unknown): unknown;
  retrieve?(name: string, input: unknown): Promise<unknown>;
  render(path: string, read: (name: string, input: unknown) => Promise<unknown>, retrieve: (name: string, input: unknown) => Promise<unknown>): Promise<PageResult>;
}
export interface RefreshRequest {
  readonly connection: string; readonly page: string;
  readonly generation: number; readonly sequence: number;
  readonly queries: readonly QueryDependency[];
  readonly force?: boolean | undefined;
  /** Explicit external refresh: these retrievals are obtained again for this view. */
  readonly retrievals?: readonly QueryDependency[] | undefined;
}
export interface RetrievalResult extends QueryDependency { readonly status: "current" | "error"; readonly error?: string; }
export interface QueryResult extends QueryDependency {
  readonly status: "current" | "error" | "loading" | "refreshing";
  readonly stale: boolean; readonly data?: unknown; readonly error?: string;
}
export interface RefreshResponse extends DatabaseRevision {
  readonly connection: string; readonly page: string; readonly generation: number; readonly sequence: number;
  readonly status: "current" | "stale" | "refreshing"; readonly rendered: PageResult;
  readonly renderError?: string;
  readonly queries: readonly QueryResult[];
  readonly retrievals?: readonly RetrievalResult[];
}
/** A view-scoped external result or failure; never a database subscription. */
interface CachedRetrieval extends QueryDependency {
  done: boolean; data?: unknown; error?: string | undefined; failure?: unknown;
  running?: Promise<void> | undefined;
}
interface CachedQuery extends QueryDependency {
  stamp?: string | undefined; data?: unknown; hasData: boolean; error?: string | undefined;
  running?: Promise<void> | undefined;
}
interface Connection {
  readonly id: string; readonly page: string; readonly path: string;
  generation: number; sequence: number; seen: number; disposed: boolean;
  readonly queries: Map<string, CachedQuery>; serverKeys: Set<string>; clientKeys: Set<string>;
  rendered?: PageResult; stamp?: DatabaseRevision | undefined; tail: Promise<unknown>;
  rendering?: Promise<void> | undefined; renderError?: string | undefined;
  readonly retrievals: Map<string, CachedRetrieval>; externalEpoch: number;
}
const safeError = (error: unknown) => error instanceof RetrievalError ? error.code : error instanceof Error && ["QUERY_TIMEOUT", "RESULT_TOO_LARGE", "QUERY_LIMIT", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "INPUT_INVALID", "NOT_FOUND"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
const stamp = (value: DatabaseRevision) => `${value.epoch}:${value.revision}`;

/** One instance belongs to one running project, including all of its browser connections. */
export class ReactiveProject {
  readonly #backend: ReactiveBackend;
  readonly #connections = new Map<string, Connection>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #executions = new Map<string, Promise<unknown>>();
  readonly #expiry: ReturnType<typeof setInterval>;
  #probing = false;
  #closed = false;
  #revisionProbe: Promise<DatabaseRevision> | undefined;
  async #revision(fresh = false): Promise<DatabaseRevision> {
    // Concurrent beginning probes may share work. A read's closing check must
    // begin after that read, so it first retires any earlier probe.
    if (fresh && this.#revisionProbe) await this.#revisionProbe.catch(() => {});
    if (!this.#revisionProbe) {
      const work = this.#backend.revision();
      this.#revisionProbe = work;
      void work.then(() => { if (this.#revisionProbe === work) this.#revisionProbe = undefined; }, () => { if (this.#revisionProbe === work) this.#revisionProbe = undefined; });
    }
    return this.#revisionProbe;
  }
  #track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work);
    void work.then(() => this.#work.delete(work), () => this.#work.delete(work));
    return work;
  }
  #query(name: string, input: unknown, revision: string): Promise<unknown> {
    const key = canonical([revision, name, input]);
    let work = this.#executions.get(key);
    if (!work) {
      work = this.#track(this.#backend.query(name, input));
      this.#executions.set(key, work);
      const completed = work;
      const remove = () => { if (this.#executions.get(key) === completed) this.#executions.delete(key); };
      void work.then(remove, remove);
    }
    return work.then(value => structuredClone(value));
  }
  constructor(backend: ReactiveBackend) {
    this.#backend = backend;
    this.#expiry = setInterval(() => { this.#expire(); void this.wake(); }, 1000);
    this.#expiry.unref?.();
  }
  async wake(): Promise<void> {
    if (this.#closed || !this.#connections.size) return;
    this.#backend.prepare?.();
    if (this.#probing) return;
    this.#probing = true;
    try {
      const revision = await this.#revision();
      for (const connection of this.#connections.values()) if (connection.stamp && stamp(connection.stamp) !== stamp(revision)) connection.stamp = undefined;
    } catch {
      for (const connection of this.#connections.values()) connection.stamp = undefined;
    } finally { this.#probing = false; }
  }
  #expire(): void {
    for (const connection of this.#connections.values()) if (performance.now() - connection.seen >= 29_000) void this.dispose(connection.id, connection.page);
  }
  #key(name: string, raw: unknown): { key: string; input: unknown } {
    const input = this.#backend.validate(name, raw);
    return { key: canonical([name, input]), input };
  }
  #retrievalKey(name: string, raw: unknown): { key: string; input: unknown } {
    if (!this.#backend.validateRetrieval) throw new Error("REQUEST_DENIED");
    const input = this.#backend.validateRetrieval(name, raw);
    return { key: canonical([name, input]), input };
  }
  /** Reuses this view's cached result unless `fresh` asks for a new retrieval. */
  #retrieval(connection: Connection, key: string, name: string, input: unknown, fresh: boolean): CachedRetrieval {
    const cached = connection.retrievals.get(key);
    if (cached && !fresh) return cached;
    if (!cached && connection.retrievals.size >= 20) throw new Error("QUERY_LIMIT");
    const retrieve = this.#backend.retrieve;
    if (!retrieve) throw new Error("REQUEST_DENIED");
    const entry: CachedRetrieval = { name, input, done: false };
    entry.running = this.#track((async () => {
      try {
        const data = await retrieve(name, input);
        validatePublicValue(data);
        entry.data = structuredClone(data);
      } catch (error) {
        // A cached failure stays a failure; it never becomes an empty result.
        entry.error = safeError(error); entry.failure = error;
      } finally { entry.done = true; entry.running = undefined; }
    })());
    connection.retrievals.set(key, entry);
    return entry;
  }
  #admit(connection: Connection, name: string, raw: unknown): CachedQuery {
    if (this.#closed) throw new Error("APPLICATION_CLOSED");
    if (connection.disposed) throw new Error("CONNECTION_EXPIRED");
    const { key, input } = this.#key(name, raw);
    const cached = connection.queries.get(key);
    if (cached) return cached;
    this.#expire();
    const total = [...this.#connections.values()].reduce((sum, item) => sum + item.queries.size, 0);
    if (connection.queries.size >= 20 || total >= 100) throw new Error("QUERY_LIMIT");
    const query = { name, input, hasData: false };
    connection.queries.set(key, query);
    return query;
  }
  async open(path: string): Promise<RefreshResponse> {
    if (this.#closed) throw new Error("APPLICATION_CLOSED");
    this.#backend.prepare?.();
    const connection: Connection = { id: randomUUID(), page: randomUUID(), path, generation: 0, sequence: 0, seen: performance.now(), disposed: false, queries: new Map(), serverKeys: new Set(), clientKeys: new Set(), tail: Promise.resolve(), retrievals: new Map(), externalEpoch: 0 };
    this.#connections.set(connection.id, connection);
    try { return await this.#refresh(connection, { connection: connection.id, page: connection.page, generation: 0, sequence: 0, queries: [] }, true); }
    catch (error) { await this.dispose(connection.id, connection.page); throw error; }
  }
  async refresh(request: RefreshRequest): Promise<RefreshResponse> {
    if (this.#closed) throw new Error("APPLICATION_CLOSED");
    this.#expire();
    const connection = this.#connections.get(request.connection);
    if (!connection || connection.page !== request.page) throw new Error("CONNECTION_EXPIRED");
    if (request.generation < connection.generation || request.sequence <= connection.sequence) throw new Error("RESPONSE_OBSOLETE");
    connection.seen = performance.now();
    const reconnect = request.generation > connection.generation;
    connection.generation = request.generation;
    connection.sequence = request.sequence;
    const run = connection.tail.catch(() => {}).then(() => this.#refresh(connection, { ...request, force: reconnect || request.force === true }));
    connection.tail = run;
    return run;
  }
  async #refresh(connection: Connection, request: RefreshRequest, initial = false): Promise<RefreshResponse> {
    if (connection.disposed || request.generation !== connection.generation || request.sequence !== connection.sequence) throw new Error("RESPONSE_OBSOLETE");
    const clientKeys = new Set(request.queries.map(query => this.#key(query.name, query.input).key));
    connection.clientKeys = clientKeys;
    const combined = new Set([...connection.serverKeys, ...clientKeys]);
    for (const key of connection.queries.keys()) if (!combined.has(key)) connection.queries.delete(key);
    const rejected = new Set<string>();
    for (const query of request.queries) {
      try { this.#admit(connection, query.name, query.input); }
      catch (error) { if (!(error instanceof Error && error.message === "QUERY_LIMIT")) throw error; rejected.add(this.#key(query.name, query.input).key); }
    }
    // Explicit external refresh replaces this view's cached entries. Database
    // rerenders never retrieve again; they reuse the cached result or failure.
    const refreshed = new Map<string, CachedRetrieval>();
    for (const retrieval of request.retrievals ?? []) {
      const { key, input } = this.#retrievalKey(retrieval.name, retrieval.input);
      if (!refreshed.has(key)) refreshed.set(key, this.#retrieval(connection, key, retrieval.name, input, true));
    }
    if (refreshed.size) {
      connection.externalEpoch++;
      await Promise.all([...refreshed.values()].map(entry => entry.running));
      if (this.#closed || connection.disposed) throw new Error("APPLICATION_CLOSED");
    }
    const before = await this.#revision();
    if (this.#closed || connection.disposed) throw new Error("APPLICATION_CLOSED");
    const currentStamp = stamp(before);
    const pending = new Set<string>();
    const read = (name: string, raw: unknown): Promise<unknown> => {
      const { key } = this.#key(name, raw);
      const query = this.#admit(connection, name, raw);
      if (!pending.has(key)) {
        pending.add(key);
        if (!query.running && (query.stamp !== currentStamp || request.force)) {
          const generation = connection.generation;
          query.stamp = undefined;
          query.running = this.#track((async () => {
            try {
              const data = await this.#query(name, query.input, currentStamp);
              validatePublicValue(data);
              if (new TextEncoder().encode(JSON.stringify(data)).length > 1048576) throw new Error("RESULT_TOO_LARGE");
              if (connection.disposed || connection.generation !== generation || connection.queries.get(key) !== query) return;
              query.data = structuredClone(data); query.hasData = true; query.error = undefined; query.stamp = currentStamp;
            } catch (error) {
              if (!connection.disposed && connection.generation === generation && connection.queries.get(key) === query) { query.error = safeError(error); query.stamp = undefined; }
            } finally { query.running = undefined; if (connection.serverKeys.has(key)) connection.stamp = undefined; }
          })());
        }
      }
      return (async () => {
        if (initial) await query.running;
        else await Promise.resolve();
        if (query.running || query.stamp !== currentStamp && !query.error) throw new Error("QUERY_PENDING");
        if (query.error) throw new Error(query.error);
        return query.data;
      })().then(value => structuredClone(value));
    };
    // Refresh independent known queries concurrently. One failure cannot hold up
    // delivery of a healthy sibling, and the render reuses each complete result.
    await Promise.allSettled([...connection.queries.values()].map(query => read(query.name, query.input)));
    if (!initial) await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (this.#closed || connection.disposed) throw new Error("APPLICATION_CLOSED");
    const waitingForServerData = connection.serverKeys.size > 0 && ![...connection.serverKeys].some(key => {
      const query = connection.queries.get(key);
      return query?.error || query?.stamp === currentStamp && !query.running;
    });
    if (!connection.rendering && !waitingForServerData && (initial || request.force || refreshed.size || !connection.stamp || stamp(connection.stamp) !== currentStamp || [...connection.serverKeys].some(key => connection.queries.get(key)?.error))) {
      const generation = connection.generation, externalEpoch = connection.externalEpoch;
      connection.rendering = this.#track((async () => {
      let rendered: PageResult | undefined;
      const used = new Set<string>(), usedRetrievals = new Set<string>();
      // Discover missing dependencies without starting another native worker
      // inside the renderer's five-second wall clock. No discovery HTML is
      // published. Only a render using complete query results can reach a view.
      for (let pass = 0; pass <= 20; pass++) {
        if (this.#closed || connection.disposed) throw new Error("APPLICATION_CLOSED");
        const discovered = new Map<string, QueryDependency>(), awaiting = new Map<string, CachedRetrieval>();
        try {
          rendered = await this.#backend.render(connection.path, async (name, input) => {
            const { key } = this.#key(name, input);
            this.#admit(connection, name, input);
            used.add(key);
            if (!pending.has(key)) { discovered.set(key, { name, input }); throw new Error("QUERY_PENDING"); }
            return read(name, input);
          }, async (name, raw) => {
            const { key, input } = this.#retrievalKey(name, raw);
            usedRetrievals.add(key);
            const entry = this.#retrieval(connection, key, name, input, false);
            // First load or new inputs retrieve outside the renderer's deadline.
            if (!entry.done) { awaiting.set(key, entry); throw new Error("QUERY_PENDING"); }
            if (entry.error) throw entry.failure;
            return structuredClone(entry.data);
          });
        } catch (error) { if (!(error instanceof Error && error.message === "QUERY_PENDING" && (discovered.size || awaiting.size))) throw error; }
        if (!discovered.size && !awaiting.size) break;
        await Promise.allSettled([...discovered.values()].map(query => read(query.name, query.input)));
        await Promise.all([...awaiting.values()].map(entry => entry.running));
        if (pass === 20) throw new Error("QUERY_LIMIT");
      }
      if (!rendered) throw new Error("INTERNAL_FAILURE");
      const renderedAt = await this.#revision(true);
      if (connection.disposed || connection.generation !== generation) return;
      if (renderedAt.epoch !== before.epoch) throw new Error("MAINTENANCE_BUSY");
      if (!initial && stamp(renderedAt) !== currentStamp) return;
      connection.serverKeys = rendered.regions.some(region => region.error) ? new Set([...connection.serverKeys, ...used]) : used;
      for (const key of connection.queries.keys()) if (!connection.clientKeys.has(key) && !connection.serverKeys.has(key)) connection.queries.delete(key);
      for (const key of connection.retrievals.keys()) if (!usedRetrievals.has(key) && !refreshed.has(key)) connection.retrievals.delete(key);
      connection.rendered = rendered;
      // A render that began before an explicit external refresh is not current.
      connection.stamp = rendered.regions.some(region => region.error) || stamp(renderedAt) !== currentStamp || connection.externalEpoch !== externalEpoch ? undefined : before;
      connection.renderError = undefined;
      })().catch(error => { connection.stamp = undefined; connection.renderError = safeError(error); if (initial) throw error; }).finally(() => { connection.rendering = undefined; }));
    }
    if (initial || refreshed.size) await connection.rendering;
    else if (connection.rendering) {
      // A native renderer may still be starting. Island query delivery has its
      // own currency and must not wait for that independent region work.
      await Promise.race([connection.rendering, new Promise<void>(resolve => setTimeout(resolve, 0))]);
    }
    const rendered = connection.rendered;
    if (!rendered) throw new Error("INTERNAL_FAILURE");
    // The second authoritative probe closes read/subscribe and in-flight commit
    // races. A differing result is explicitly stale and triggers a trailing read.
    const after = await this.#revision(true);
    if (after.epoch !== before.epoch) { connection.stamp = undefined; throw new Error("MAINTENANCE_BUSY"); }
    const current = stamp(after) === currentStamp;
    if (!current) connection.stamp = undefined;
    if (connection.disposed || request.generation !== connection.generation || request.sequence !== connection.sequence) throw new Error("RESPONSE_OBSOLETE");
    return { ...before, connection: connection.id, page: connection.page, generation: request.generation, sequence: request.sequence,
      status: !current ? "stale" : connection.rendering || !connection.stamp || stamp(connection.stamp) !== currentStamp ? "refreshing" : "current", rendered,
      ...(connection.renderError ? { renderError: connection.renderError } : {}),
      queries: request.queries.map(query => {
        const { key, input } = this.#key(query.name, query.input);
        if (rejected.has(key)) return { name: query.name, input, status: "error", stale: true, error: "QUERY_LIMIT" };
        const cached = connection.queries.get(key)!;
        const waiting = Boolean(cached.running) || cached.stamp !== currentStamp && !cached.error;
        return { name: query.name, input, status: cached.error ? "error" : waiting ? cached.hasData ? "refreshing" : "loading" : "current", stale: !current || Boolean(cached.error) || waiting, ...(cached.hasData ? { data: structuredClone(cached.data) } : {}), ...(cached.error ? { error: cached.error } : {}) };
      }),
      ...(request.retrievals ? { retrievals: request.retrievals.map(retrieval => {
        const entry = refreshed.get(this.#retrievalKey(retrieval.name, retrieval.input).key)!;
        return { name: entry.name, input: entry.input, ...(entry.error ? { status: "error" as const, error: entry.error } : { status: "current" as const }) };
      }) } : {}),
    };
  }
  async dispose(id: string, page: string): Promise<void> {
    const connection = this.#connections.get(id);
    if (connection?.page !== page) return;
    connection.disposed = true;
    this.#connections.delete(id);
    connection.queries.clear(); connection.retrievals.clear();
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#expiry);
    for (const connection of this.#connections.values()) { connection.disposed = true; connection.queries.clear(); }
    this.#connections.clear();
    while (this.#work.size) await Promise.allSettled(this.#work);
    await this.#revisionProbe?.catch(() => {});
  }
}
