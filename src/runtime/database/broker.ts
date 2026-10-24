import { SQL } from "bun";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startOwnedControl, type ControlResult } from "./control-process";
import { CleanupLease } from "./cleanup";
import type { ColumnReference, Filter, Join, JoinedOptions, JoinedProjection, ReadDb, Row, SelectOptions, Selected, Table } from "../../database";
import { validatePublicValue } from "../../schema";
import { PublicOperationError } from "../../server";
import { references, tableDefinitions } from "../declarations";

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
  readonly #cursorKey = randomBytes(32);
  readonly #tables: ReadonlySet<Table>;
  constructor(options: { url: string; tables: readonly Table[] }) {
    this.#url = options.url;
    this.#pool = new SQL(options.url, { max: 4, connectionTimeout: 5 });
    this.#tables = new Set(options.tables);
    const names = options.tables.map(table => tableDefinitions.get(table)?.name);
    if (names.includes(undefined) || new Set(names).size !== names.length) throw new Error("Invalid table registry");
  }
  async read<T>(trustedDispatch: (db: ReadDb, remainingMs: () => number) => Promise<T>, identity: QueryIdentity = { operation: "internal", input: {} }): Promise<T> {
    const started = performance.now();
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
      connection = await this.#pool.reserve({ signal: abort.signal });
      check();
      const backendIdentity = await execute("SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()");
      if (!Array.isArray(backendIdentity) || backendIdentity.length !== 1 || !Number.isSafeInteger(backendIdentity[0]?.pid) || typeof backendIdentity[0]?.started !== "string") throw new Error("INTERNAL_FAILURE");
      backend = { pid: backendIdentity[0].pid as number, started: backendIdentity[0].started as string };
      await execute("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      await execute("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, Math.floor(5000 - (performance.now() - started))))]);
      const db: ReadDb = Object.freeze({
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
      const result = await Promise.race([trustedDispatch(db, () => { check(); return Math.max(1, Math.floor(5000 - (performance.now() - started))); }), expired]);
      check();
      publicResult(result);
      return result;
    } catch (error) {
      if (abort.signal.aborted || performance.now() - started >= 5000
        || (error instanceof SQL.PostgresError && (error.errno === "57014" || error.code === "ERR_POSTGRES_CONNECTION_TIMEOUT"))) throw new Error("QUERY_TIMEOUT");
      if (error instanceof PublicOperationError) throw error;
      if (error instanceof Error && ["QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "REQUEST_DENIED"].includes(error.message)) throw error;
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
          else await borrowed.close({ timeout: 0 });
        } finally { clearTimeout(cleanupTimer); }
      }
    }
  }
  async close(): Promise<void> { await this.#pool.close({ timeout: 0 }); }
}
