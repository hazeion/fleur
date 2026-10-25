import { SQL } from "bun";
import { MaintenanceLease, type MaintenanceConfiguration } from "./maintenance";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startOwnedControl, type ControlResult } from "./control-process";
import { CleanupLease } from "./cleanup";
import type { WriteDb, ColumnReference, Filter, Join, JoinedOptions, JoinedProjection, ReadDb, Row, SelectOptions, Selected, Table } from "../../database";
import { validatePublicValue } from "../../schema";
import { PublicOperationError } from "../../server";
import { references, tableDefinitions } from "../declarations";

import { writeHelpers } from "./writes";
import { compileRead, type QueryIdentity } from "./selection";

const resultLimit = 1024 * 1024;
function publicResult(value: unknown): void {
  validatePublicValue(value);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > resultLimit) throw new Error("RESULT_TOO_LARGE");
}
function normalize<T extends Table, F extends readonly (keyof Row<T>)[]>(table: T, options: SelectOptions<Row<T>, F>) {
  const spec = tableDefinitions.get(table);
  if (!spec || Object.keys(options).some(key => !["fields", "where", "orderBy", "limit", "cursor"].includes(key)) || !Array.isArray(options.fields) || !options.fields.length || new Set(options.fields).size !== options.fields.length) throw new Error("REQUEST_DENIED");
  const get = (key: string) => {
    if (!Object.hasOwn(spec.columns, key)) throw new Error("REQUEST_DENIED");
    return spec.columns[key]!;
  };
  return {
    from: table, joins: [], fields: Object.fromEntries(options.fields.map(key => [String(key), get(String(key))])),
    ...(options.orderBy === undefined ? {} : { orderBy: options.orderBy.map(item => ({ column: get(item.field), direction: item.direction })) }),
    ...(options.where === undefined ? {} : { where: options.where }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  };
}

/** Trusted broker only. Application callbacks execute in the restricted worker. */
export class ReadBroker {
  readonly #pool: SQL;
  readonly #url: string;
  readonly #maintenance: MaintenanceConfiguration;
  readonly #cursorKey = randomBytes(32);
  readonly #tables: ReadonlySet<Table>;
  constructor(options: { url: string; tables: readonly Table[]; maintenance?: MaintenanceConfiguration }) {
    this.#maintenance = options.maintenance ?? {};
    this.#url = options.url;
    this.#pool = new SQL(options.url, { max: 4, connectionTimeout: 5 });
    this.#tables = new Set(options.tables);
    const names = options.tables.map(table => tableDefinitions.get(table)?.name);
    if (names.includes(undefined) || new Set(names).size !== names.length) throw new Error("Invalid table registry");
  }
  async read<T>(trustedDispatch: (db: ReadDb, remainingMs: () => number) => Promise<T>, identity: QueryIdentity = { operation: "internal", input: {} }): Promise<T> {
    return this.#transaction(trustedDispatch, identity, false);
  }
  async mutate<T>(trustedDispatch: (db: WriteDb, remainingMs: () => number) => Promise<T>, identity: QueryIdentity = { operation: "internal", input: {} }): Promise<T> {
    return this.#transaction((db, remaining) => trustedDispatch(db as WriteDb, remaining), identity, true);
  }
  async #transaction<T>(trustedDispatch: (db: ReadDb, remainingMs: () => number) => Promise<T>, identity: QueryIdentity, writable: boolean): Promise<T> {
    const started = performance.now();
    let admission: MaintenanceLease | undefined;
    let commitAttempted = false, committed = false;
    let fault: unknown;
    let outstanding = 0;
    const abort = new AbortController();
    let expire: () => void = () => {};
    const expired = new Promise<never>((_resolve, reject) => { expire = () => { abort.abort(); reject(new Error("QUERY_TIMEOUT")); }; });
    void expired.catch(() => {});
    const timer = setTimeout(expire, 5000);
    let connection: Awaited<ReturnType<SQL["reserve"]>> | undefined;
    let active: ReturnType<SQL["unsafe"]> | undefined;
    let pending: Promise<unknown> | undefined;
    let valid = true;
    let backend: { pid: number; started: string } | undefined;
    let cancellation: Promise<ControlResult> | undefined;
    const control = async (action: "cancel" | "terminate"): Promise<ControlResult> => {
      if (!backend) return "failed";
      try {
        return await startOwnedControl([process.execPath, fileURLToPath(new URL("./control-worker.ts", import.meta.url))],
          { action, ...backend }, { FLEUR_PRIVATE_DATABASE_URL: this.#url }, 250).result;
      } catch { return "failed"; }
    };
    const cancel = () => { cancellation = control("cancel"); };
    abort.signal.addEventListener("abort", cancel, { once: true });
    const check = () => { if (!valid || abort.signal.aborted || performance.now() - started >= 5000) throw new Error("QUERY_TIMEOUT"); };
    const execute = async (text: string, values: unknown[] = []) => {
      check();
      if (!connection) throw new Error("INTERNAL_FAILURE");
      if (active) throw new Error("REQUEST_DENIED");
      active = connection.unsafe(text, values);
      pending = Promise.resolve(active);
      try { return await Promise.race([pending, expired]); }
      finally { if (!abort.signal.aborted) active = undefined; }
    };
    try {
      const admitted = MaintenanceLease.acquire(this.#url, false, {...this.#maintenance,tables:[...this.#tables]});
      void admitted.then(lease => { if (abort.signal.aborted) void lease.close().catch(() => {}); }).catch(() => {});
      admission = await Promise.race([admitted, expired]);
      connection = await this.#pool.reserve({ signal: abort.signal });
      check();
      const backendIdentity = await execute("SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()");
      if (!Array.isArray(backendIdentity) || backendIdentity.length !== 1 || !Number.isSafeInteger(backendIdentity[0]?.pid) || typeof backendIdentity[0]?.started !== "string") throw new Error("INTERNAL_FAILURE");
      backend = { pid: backendIdentity[0].pid as number, started: backendIdentity[0].started as string };
      await execute(writable ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      const fence = await execute("SELECT pg_try_advisory_xact_lock_shared($1::bigint) AS acquired", [admission.key]);
      if (!Array.isArray(fence) || fence[0]?.acquired !== true) throw new Error("MAINTENANCE_BUSY");
      await Promise.race([admission.assertSession(), expired]);
      await execute("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(5000 - (performance.now() - started))))]);
      let db: ReadDb = Object.freeze({
        cursorJoined: <const P extends Readonly<Record<string, ColumnReference>>, const J extends readonly Join[]>(options: Omit<JoinedOptions<P, J>, "cursor" | "limit"> & { readonly after: JoinedProjection<P, J> }) => {
          check();
          const { after, ...selection } = options;
          validatePublicValue(after);
          return compileRead(selection, this.#tables, this.#cursorKey, identity).encode(column => {
            const field = Object.entries(selection.fields).find(([, reference]) => reference === column)?.[0];
            if (field === undefined || !Object.hasOwn(after, field)) throw new Error("REQUEST_DENIED");
            return after[field];
          });
        },
        cursor: <Target extends Table>(table: Target, options: { where?: Filter; orderBy?: SelectOptions<Row<Target>, readonly (keyof Row<Target>)[]>["orderBy"]; after: Partial<Row<Target>> }) => {
          check();
          if (!this.#tables.has(table)) throw new Error("REQUEST_DENIED");
          const fields = Object.keys(tableDefinitions.get(table)!.columns) as (keyof Row<Target>)[];
          const selectionOptions = { fields, ...(options.where === undefined ? {} : { where: options.where }), ...(options.orderBy === undefined ? {} : { orderBy: options.orderBy }) };
          return compileRead(normalize(table, selectionOptions), this.#tables, this.#cursorKey, identity).encode(column => options.after[references.get(column)!.field as keyof Row<Target>]);
        },
        selectJoined: async <const P extends Readonly<Record<string, ColumnReference>>, const J extends readonly Join[]>(options: JoinedOptions<P, J>) => {
          check();
          const plan = compileRead(options, this.#tables, this.#cursorKey, identity);
          const result = plan.decode(await execute(plan.sql, plan.values));
          publicResult(result);
          return result as JoinedProjection<P, J>[];
        },
        select: async <Target extends Table, const F extends readonly (keyof Row<Target>)[]>(table: Target, options: SelectOptions<Row<Target>, F>) => {
        check();
        if (!this.#tables.has(table)) throw new Error("REQUEST_DENIED");
        const plan = compileRead(normalize(table, options), this.#tables, this.#cursorKey, identity);
        const result = plan.decode(await execute(plan.sql, plan.values));
        publicResult(result);
        return result as Selected<Row<Target>, F>[];
      } });
      if (writable) {
        const helpers = { ...db, ...writeHelpers(execute, this.#tables) };
        db = Object.freeze(Object.fromEntries(Object.entries(helpers).map(([key, method]) => [key, (...args: unknown[]) => {
          check();
          if (fault) throw fault;
          try {
            const result: unknown = Reflect.apply(method, helpers, args);
            if (result instanceof Promise) {
              outstanding++;
              const guarded = result.then(value => { publicResult(value); return value; }).catch(error => { fault = error; throw error; }).finally(() => { outstanding--; });
              void guarded.catch(() => {});
              return guarded;
            }
            publicResult(result);
            return result;
          } catch (error) { fault = error; throw error; }
        }]))) as unknown as ReadDb;
      }
      const result = await Promise.race([trustedDispatch(db, () => { check(); return Math.max(1, Math.floor(5000 - (performance.now() - started))); }), expired]);
      check();
      publicResult(result);
      if (writable) {
        if (fault) throw fault;
        if (outstanding || active) throw new Error("REQUEST_DENIED");
        check();
        await Promise.race([admission.assertSession(), expired]);
        commitAttempted = true;
        await execute("COMMIT");
        committed = true;
      }
      return result;
    } catch (caught) {
      const error = writable && fault ? fault : caught;
      // PostgreSQL's integrity rejection acknowledges that COMMIT failed.
      // Transport loss or a deadline without that acknowledgement stays unknown.
      if (writable && error instanceof SQL.PostgresError && error.errno?.startsWith("23")) throw new PublicOperationError("CONSTRAINT_CONFLICT");
      if (commitAttempted && !committed) throw new Error("OUTCOME_UNKNOWN");
      if (writable && error instanceof SQL.PostgresError && error.errno === "22003") throw new PublicOperationError("CONSTRAINT_CONFLICT");
      if (abort.signal.aborted || performance.now() - started >= 5000
        || (error instanceof SQL.PostgresError && (error.errno === "57014" || error.code === "ERR_POSTGRES_CONNECTION_TIMEOUT"))) throw new Error("QUERY_TIMEOUT");
      if (error instanceof PublicOperationError) throw error;
      if (error instanceof Error && ["QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "REQUEST_DENIED", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SCHEMA_DRIFT", "MIGRATIONS_PENDING", "CONFIGURATION_MISSING", "PREREQUISITE_UNAVAILABLE"].includes(error.message)) throw error;
      throw new Error("INTERNAL_FAILURE");
    } finally {
      valid = false;
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancel);
      if (connection) {
        const borrowed = connection;
        const lease = new CleanupLease();
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            lease.verify(borrowed, cancellation, pending, true),
            new Promise<never>((_resolve, reject) => { cleanupTimer = setTimeout(() => { lease.expire(); reject(new Error("Cleanup timeout")); }, 250); }),
          ]);
          lease.assertActive();
          lease.expire();
          borrowed.release();
        } catch {
          lease.expire();
          const stopped = await control("terminate");
          if (stopped === "applied" || stopped === "absent") borrowed.release();
          // An unverified connection must never return to circulation. Closing
          // this reserved handle discards its socket; the driver's onClose
          // releases only its slot, so healthy reads and pool shutdown can finish.
          else { try { await borrowed.close({ timeout: 0 }); } catch { /* Preserve the established primary outcome; never release an uncertain handle. */ } }
        } finally { clearTimeout(cleanupTimer); }
      }
      await admission?.close();
    }
  }
  async close(): Promise<void> { await this.#pool.close({ timeout: 0 }); }
}
