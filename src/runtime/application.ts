import { queryIdentity } from "./query-identity";
import type { DatabaseRevision } from "./database/revision";
import { ARMING_MARGIN_MS, NativeExecution, type Reservation } from "./native/execution";
import { randomUUID } from "node:crypto";
import { MaintenanceLease, type MaintenanceConfiguration } from "./database/maintenance";
import { ReadBroker } from "./database/broker";
import { startWorker } from "./native/host";
import { restoreManifest, type Registry } from "./manifest-wire";
import { dispatchRead, dispatchWrite } from "./read-wire";
import { selectPage } from "./routes";
import { validatePublicValue } from "../schema";
import type { ReadDb, WriteDb } from "../database";
import type { PageResult } from "./worker-execution";
import { PublicOperationError, type DeclaredErrorCode } from "../server";
import { OutboundBroker, credentialsFromEnvironment, type RetrievalConfiguration } from "./retrieval/outbound";
import { RetrievalError, retrievalFailureCodes, type RetrievalFailureCode } from "./retrieval/destinations";
import { canonical } from "./canonical";

import type { NativeImages as Images } from "./native/endpoint";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REQUEST_DENIED");
  return value as Record<string, unknown>;
}
const isRetrievalCode = (code: unknown): code is RetrievalFailureCode => retrievalFailureCodes.includes(code as RetrievalFailureCode);
function retrievalFailure(code: RetrievalFailureCode, details: unknown): RetrievalError {
  const status = details && typeof details === "object" && "status" in details ? details.status : undefined;
  return new RetrievalError(code, typeof status === "number" ? status : undefined);
}
/** Distinct external requests one retrieval operation may make; not a concurrency cap. */
const RETRIEVAL_REQUESTS = 20;
/** Time kept from an external request for the handler to handle its failure. */
const RETRIEVAL_HANDLER_RESERVE_MS = 2000;
function publicBound(value: unknown): void {
  validatePublicValue(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1048576) throw new Error("RESULT_TOO_LARGE");
}
/** A render's nested query; `abandoned` aborts once the render stops waiting for it. */
type NestedRead = (name: string, input: unknown, abandoned?: AbortSignal) => Promise<unknown>;
export class ReadApplication {
  readonly registry: Registry;
  readonly #broker: ReadBroker;
  readonly #maintenance: MaintenanceConfiguration;
  readonly #url: string;
  readonly #execution: NativeExecution;
  readonly #outbound: OutboundBroker;
  /** Nested queries and retrieval runs waiting for a slot; each blocks a render that holds a slot. */
  readonly #stalled = new Set<AbortController>();
  private constructor(execution: NativeExecution, registry: Registry, url: string, maintenance: MaintenanceConfiguration, outbound: OutboundBroker) {
    this.registry = registry; this.#maintenance = {...maintenance,tables:registry.tables,completeRegistry:true}; this.#url = url; this.#outbound = outbound;
    this.#broker = new ReadBroker({ url, tables: registry.tables, maintenance: this.#maintenance });
    this.#execution = execution;
  }
  /** `retrieval` is trusted startup configuration: limits, credential bindings and local-service exceptions. */
  static async open(images: Images, url: string, maintenance: MaintenanceConfiguration = {}, retrieval: RetrievalConfiguration = {}): Promise<ReadApplication> {
    const admission = await MaintenanceLease.acquire(url, false, maintenance);
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    const session = randomUUID();
    let registry: Registry;
    try {
      worker = await startWorker(images);
      const result = record(await worker.run({ mode: "register", session }, () => { throw new Error("REQUEST_DENIED"); }));
      if (result.kind !== "complete" || result.session !== session || result.sequence !== 0 || Object.keys(result).length !== 4) throw new Error("SOURCE_REJECTED");
      registry=restoreManifest(result.value);
      const checked=await MaintenanceLease.acquire(url,false,{...maintenance,tables:registry.tables,completeRegistry:true});
      await checked.close();
    } finally { try { await worker?.close(); } finally { await admission.close(); } }
    // Declared credentials must be configured and bound before any worker starts.
    // Bindings come from the trusted startup environment unless supplied explicitly.
    const outbound = new OutboundBroker(registry.destinations, { ...retrieval, credentials: retrieval.credentials ?? credentialsFromEnvironment(process.env) });
    // Cold slot creation is startup work and never holds maintenance admission.
    const execution = await NativeExecution.open(images);
    try { return new ReadApplication(execution, registry, url, maintenance, outbound); }
    catch (error) { await execution.close(); throw error; }
  }
  async #execute(reservation: Reservation, command: Record<string, unknown>, db?: ReadDb, budgetMs = 5000, read: NestedRead = (name, input) => this.query(name, input), retrieve: NestedRead = (name, input) => this.retrieve(name, input), external?: (request: unknown) => Promise<unknown>): Promise<unknown> {
    const session = randomUUID();
    let sequence = 0, admitted = false;
    let operationFault: unknown;
    const result = record((await reservation.run({ ...command, session }, async input => {
      const request = record(input);
      if (Object.keys(request).length !== 4 || request.session !== session || request.sequence !== sequence++ || typeof request.kind !== "string") throw new Error("REQUEST_DENIED");
      let value: unknown;
      try {
        if (request.kind === "registry" && !admitted && sequence === 1) {
          if (JSON.stringify(request.value) !== this.registry.encoded) throw new Error("SOURCE_REJECTED");
          admitted = true; value = null;
        } else if (!admitted) throw new Error("REQUEST_DENIED");
        else if (request.kind === "read" && command.mode === "query" && db) value = await dispatchRead(request.value, db, this.registry.tables);
        else if (request.kind === "write" && command.mode === "mutation" && db) value = await dispatchWrite(request.value, db as WriteDb, this.registry.tables);
        else if (request.kind === "external" && command.mode === "retrieval" && !db && external) value = await external(request.value);
        else if ((request.kind === "query" || request.kind === "retrieval") && command.mode === "render" && !db) {
          const query = record(request.value);
          if (Object.keys(query).length !== 2 || typeof query.name !== "string") throw new Error("REQUEST_DENIED");
          // A nested query or retrieval never outlives the render that requested
          // it. The render stops waiting on it at once: abandonment precedes the
          // reply, and also ends a nested retrieval's slot waits and fetches.
          const abandoned = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            value = await Promise.race([(request.kind === "query" ? read : retrieve)(query.name, query.input, abandoned.signal), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { abandoned.abort(new Error("QUERY_TIMEOUT")); reject(new Error("QUERY_TIMEOUT")); }, Math.max(0, reservation.deadline - performance.now())); })]);
          } finally { clearTimeout(timer); }
        } else if (request.kind === "log" && (command.mode === "query" || command.mode === "mutation" || command.mode === "retrieval")) {
          const log = record(request.value);
          if (Object.keys(log).length !== 2 || !["info", "warn"].includes(String(log.level)) || typeof log.message !== "string" || log.message.length > 1024) throw new Error("REQUEST_DENIED");
          value = null;
        } else throw new Error("REQUEST_DENIED");
        publicBound(value);
        return { session, sequence: request.sequence, value };
      } catch (error) {
        if (command.mode === "mutation") operationFault ??= error;
        if (error instanceof PublicOperationError || error instanceof RetrievalError) return { session, sequence: request.sequence, error: error.code, ...(error.details === undefined ? {} : { details: error.details }) };
        const code = error instanceof Error && ["QUERY_PENDING", "REQUEST_DENIED", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "RETRIEVAL_PENDING"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
        return { session, sequence: request.sequence, error: code };
      }
    }, budgetMs)).value);
    if (operationFault) throw operationFault;
    if (!admitted || result.session !== session || result.sequence !== sequence || Object.keys(result).some(key => !["kind", "session", "sequence", "value", "code", "details"].includes(key))) throw new Error("REQUEST_DENIED");
    if (result.kind === "failure") {
      if (["INPUT_INVALID", "NOT_FOUND", "CONSTRAINT_CONFLICT", "VERSION_CONFLICT", "UNSUPPORTED_CAPABILITY"].includes(String(result.code))) throw new PublicOperationError(result.code as DeclaredErrorCode, result.details);
      if (command.mode !== "query" && command.mode !== "mutation" && isRetrievalCode(result.code)) throw retrievalFailure(result.code, result.details);
      if (command.mode === "retrieval" && result.code === "RETRIEVAL_PENDING") throw new Error("RETRIEVAL_PENDING");
      const code = typeof result.code === "string" && ["REQUEST_DENIED", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "ROUTE_INVALID", "ROUTE_NOT_FOUND", "UNSUPPORTED_CAPABILITY"].includes(result.code) ? result.code : "INTERNAL_FAILURE";
      throw new Error(code);
    }
    if (result.kind !== "complete" || Object.keys(result).length !== 4 || !Object.hasOwn(result, "value")) throw new Error("REQUEST_DENIED");
    publicBound(result.value);
    return result.value;
  }
  query(name: string, rawInput: unknown): Promise<unknown> { return this.#query(name, rawInput); }
  /** `limit` caps a nested query by its enclosing render's deadline; `abandoned` aborts once that render stops waiting. */
  async #query(name: string, rawInput: unknown, limit = Infinity, abandoned?: AbortSignal): Promise<unknown> {
    const operation = this.registry.queries.get(name);
    if (!operation) throw new Error("REQUEST_DENIED");
    let input: unknown;
    try { input = operation.input.parse(rawInput); } catch { throw new PublicOperationError("INPUT_INVALID"); }
    // One deadline covers queueing, preparation, the transaction and execution.
    const started = Math.min(performance.now(), limit - 5000);
    const reservation = limit === Infinity ? await this.#execution.reserve(started + 5000) : await this.#reserveNested(started + 5000, abandoned);
    try {
      return await this.#broker.read(async (db, remaining) => operation.output.parse(await this.#execute(reservation, { mode: "query", operation: name, input }, db, remaining())), queryIdentity(name, operation.input, input), started);
    } finally { reservation.release(); }
  }
  /**
   * A nested query waiting for a slot blocks the render that requested it, and
   * that render holds a slot of its own until the query settles or the render
   * stops waiting. Once as many nested queries wait as there are slots, every
   * slot holds such a render: none can be admitted before the render deadlines,
   * so all of them fail now with QUERY_LIMIT. While fewer wait, some slot holds
   * other work that can free it, so they keep waiting and are admitted normally.
   */
  async #reserveNested(deadline: number, abandoned?: AbortSignal): Promise<Reservation> {
    abandoned?.throwIfAborted();
    const stalled = new AbortController();
    // A render that stopped waiting is no longer blocked by this query.
    const leave = () => { this.#stalled.delete(stalled); };
    abandoned?.addEventListener("abort", leave, { once: true });
    this.#stalled.add(stalled);
    if (this.#stalled.size >= this.#execution.capacity) {
      for (const each of this.#stalled) each.abort(new Error("QUERY_LIMIT"));
      this.#stalled.clear();
    }
    try { return await this.#execution.reserve(deadline, abandoned ? AbortSignal.any([abandoned, stalled.signal]) : stalled.signal); }
    finally { leave(); abandoned?.removeEventListener("abort", leave); }
  }
  async mutate(name: string, rawInput: unknown): Promise<unknown> {
    const operation = this.registry.mutations.get(name);
    if (!operation) throw new Error("REQUEST_DENIED");
    let input: unknown;
    try { input = operation.input.parse(rawInput); } catch { throw new PublicOperationError("INPUT_INVALID"); }
    const started = performance.now();
    const reservation = await this.#execution.reserve(started + 5000);
    // A run returns only after its guard confirmed physical exit and that only
    // the container's idle init remains, so retirement precedes COMMIT.
    try {
      return await this.#broker.mutate(async (db, remaining) =>
        operation.output.parse(await this.#execute(reservation, { mode: "mutation", operation: name, input }, db, remaining())), { operation: name, input }, started);
    } finally {
      // Release is scheduling bookkeeping; it must never replace a transaction outcome.
      try { reservation.release(); } catch { /* Preserve the committed or unknown outcome. */ }
    }
  }
  /**
   * Runs a registered retrieval under one whole-operation deadline covering
   * worker queueing, handler execution, DNS, connection and body reads.
   * Handlers run in fresh isolated workers with no network. Each new external
   * request ends that worker run; the trusted broker performs it outside the
   * worker deadline, then a fresh run replays the handler with the recorded
   * outcomes. A run that requested nothing new is the result.
   */
  retrieve(name: string, rawInput: unknown): Promise<unknown> { return this.#retrieve(name, rawInput); }
  /**
   * `limit` caps a render's nested retrieval by the render deadline; `abandoned`
   * aborts its slot waits and outbound request once that render stops waiting.
   * Each handler run needs a slot, so a nested retrieval's slot waits count
   * toward the nested fail-fast; its outbound requests hold no slot and do not.
   */
  async #retrieve(name: string, rawInput: unknown, limit = Infinity, abandoned?: AbortSignal): Promise<unknown> {
    const operation = this.registry.retrievals.get(name);
    if (!operation) throw new Error("REQUEST_DENIED");
    let input: unknown;
    try { input = operation.input.parse(rawInput); } catch { throw new PublicOperationError("INPUT_INVALID"); }
    const deadline = Math.min(this.#outbound.deadline(), limit);
    // External requests end early enough that the handler still runs after a
    // timeout and can handle RETRIEVAL_TIMEOUT explicitly. The reserve always
    // covers a run's arming margin. It also covers the rerun as the run that asked
    // for the request measured it: its slot wait plus the larger of the arming
    // margin and its execution, so a loaded host still has time for the rerun.
    // When less remains, no request is made.
    const reserve = Math.min(RETRIEVAL_HANDLER_RESERVE_MS, Math.max(ARMING_MARGIN_MS + 250, Math.floor((deadline - performance.now()) / 4)));
    const outcomes = new Map<string, { value: unknown } | { error: unknown }>();
    // RETRIEVAL_TIMEOUT means the whole retrieval deadline expired, or too
    // little of it remains for a run to start. A worker run that exceeds its
    // own operation deadline first keeps the operation code.
    const expired = (error: unknown) => error instanceof Error && error.message === "QUERY_TIMEOUT" && deadline - performance.now() < ARMING_MARGIN_MS ? new RetrievalError("RETRIEVAL_TIMEOUT") : error;
    for (;;) {
      abandoned?.throwIfAborted();
      if (deadline - performance.now() < 1) throw new RetrievalError("RETRIEVAL_TIMEOUT");
      const pending = new Map<string, unknown>();
      const external = async (request: unknown): Promise<unknown> => {
        let key: string;
        try { key = canonical(request); } catch { throw new RetrievalError("RETRIEVAL_DESTINATION_DENIED"); }
        const outcome = outcomes.get(key);
        if (outcome) { if ("error" in outcome) throw outcome.error; return outcome.value; }
        if (!pending.has(key) && outcomes.size + pending.size >= RETRIEVAL_REQUESTS) throw new Error("QUERY_LIMIT");
        pending.set(key, request);
        throw new Error("RETRIEVAL_PENDING");
      };
      let result: { value: unknown } | { error: unknown };
      let reservation: Reservation;
      const runStarted = performance.now();
      const reserveBy = Math.min(deadline, runStarted + 5000);
      try { reservation = limit === Infinity ? await this.#execution.reserve(reserveBy) : await this.#reserveNested(reserveBy, abandoned); }
      catch (error) { throw expired(error); }
      const reserved = performance.now();
      try {
        const budget = Math.min(5000, Math.floor(deadline - performance.now()));
        if (budget < 1) throw new Error("QUERY_TIMEOUT");
        result = { value: await this.#execute(reservation, { mode: "retrieval", operation: name, input }, undefined, budget, undefined, undefined, external) };
      } catch (error) { result = { error }; }
      finally { reservation.release(); }
      if (!pending.size) {
        if ("error" in result) throw expired(result.error);
        try { return operation.output.parse(result.value); } catch { throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT"); }
      }
      const rerun = reserved - runStarted + Math.max(ARMING_MARGIN_MS, performance.now() - reserved) + 250;
      const requestDeadline = deadline - Math.max(reserve, rerun);
      await Promise.all([...pending].map(async ([key, request]) => {
        try { outcomes.set(key, { value: await this.#outbound.request(request, requestDeadline, abandoned) }); }
        catch (error) { outcomes.set(key, { error: error instanceof RetrievalError ? error : new RetrievalError("RETRIEVAL_TRANSPORT_FAILURE") }); }
      }));
    }
  }
  revision(): Promise<DatabaseRevision> { return this.#broker.revision(); }
  prepareWorkers(): void { this.#execution.warm(); }
  /** Slot states for operator visibility; no secrets or application data. */
  diagnostics(): ReturnType<NativeExecution["diagnostics"]> { return this.#execution.diagnostics(); }
  /** The most slots this application's execution holds. */
  get capacity(): number { return this.#execution.capacity; }
  watch(wakeup: () => void): Promise<() => Promise<void>> { return this.#broker.watch(wakeup); }
  async render(path: string, read?: (name: string, input: unknown) => Promise<unknown>, retrieve?: (name: string, input: unknown) => Promise<unknown>): Promise<PageResult> {
    // Route validation also runs in the trusted host before application entry.
    try {
      if (!selectPage([...this.registry.pages.values()], path)) throw new Error("ROUTE_NOT_FOUND");
    } catch (error) { throw new Error(error instanceof Error && error.message === "ROUTE_NOT_FOUND" ? error.message : "ROUTE_INVALID"); }
    // Reserve before admission, like queries and mutations: waiting for a
    // slot never holds the shared maintenance lock that maintenance drains.
    // One deadline bounds slot queueing, admission, the render run and every
    // nested query it requests.
    const deadline = performance.now() + 5000;
    const reservation = await this.#execution.reserve(deadline);
    try {
      const remaining = deadline - performance.now();
      if (remaining < 1) throw new Error("QUERY_TIMEOUT");
      // Admission is bounded by the render deadline itself: a stalled control
      // connection need not settle when the lease's own bound closes it. The
      // deadline timer is registered first and fires no later than that bound.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("QUERY_TIMEOUT")), Math.max(0, deadline - performance.now())); });
      const acquiring = MaintenanceLease.acquire(this.#url, false, { ...this.#maintenance, timeoutMs: Math.ceil(remaining) });
      let admission: MaintenanceLease;
      try { admission = await Promise.race([acquiring, expired]); }
      catch (error) {
        // An admission granted after the deadline is closed, never used.
        // Closing it is best effort: the caller's outcome is already decided.
        void acquiring.then(lease => lease.close()).catch(() => {});
        throw error;
      } finally { clearTimeout(timer); }
      try { return await this.#render(reservation, read ?? ((name, input, abandoned) => this.#query(name, input, deadline, abandoned)), retrieve ?? ((name, input, abandoned) => this.#retrieve(name, input, deadline, abandoned)), path); } finally { await admission.close(); }
    } finally { reservation.release(); }
  }
  async #render(reservation: Reservation, read: NestedRead, retrieve: NestedRead, path: string): Promise<PageResult> {
    {
      const result = record(await this.#execute(reservation, { mode: "render", path }, undefined, 5000, read, retrieve));
      if (Object.keys(result).length !== 3 || typeof result.html !== "string" || !Array.isArray(result.islands) || result.islands.length > 500 || !Array.isArray(result.regions) || result.regions.length > 500) throw new Error("INTERNAL_FAILURE");
      const regionIds = new Set<string>();
      for (const raw of result.regions) {
        const region = record(raw);
        if (Object.keys(region).some(key => !["id", "dependencies", "error"].includes(key)) || typeof region.id !== "string" || region.id.length > 8192 || regionIds.has(region.id) || !Array.isArray(region.dependencies) || region.dependencies.length > 100 || (region.error !== undefined && !["QUERY_PENDING", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "INPUT_INVALID", "NOT_FOUND", "INTERNAL_FAILURE", ...retrievalFailureCodes].includes(String(region.error)))) throw new Error("INTERNAL_FAILURE");
        regionIds.add(region.id);
        for (const rawDependency of region.dependencies) {
          const dependency = record(rawDependency);
          if (Object.keys(dependency).length !== 2 || typeof dependency.name !== "string") throw new Error("INTERNAL_FAILURE");
          const operation = this.registry.queries.get(dependency.name);
          if (!operation) throw new Error("REQUEST_DENIED");
          operation.input.parse(dependency.input);
        }
      }
      const keys = new Set<string>();
      for (const raw of result.islands) {
        const island = record(raw);
        if (Object.keys(island).length !== 3 || typeof island.id !== "string" || typeof island.key !== "string" || !/^island-[0-9]{1,3}$/.test(island.key) || keys.has(island.key)) throw new Error("INTERNAL_FAILURE");
        keys.add(island.key);
        const schema = this.registry.islands.get(island.id);
        if (!schema) throw new Error("INTERNAL_FAILURE");
        schema.parse(island.props);
      }
      return result as unknown as PageResult;
    }
  }
  async close(): Promise<void> { try { await this.#execution.close(); } finally { await this.#broker.close(); } }
}
