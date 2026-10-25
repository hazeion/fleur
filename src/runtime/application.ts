import { queryIdentity } from "./query-identity";
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

import type { NativeImages as Images } from "./native/endpoint";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REQUEST_DENIED");
  return value as Record<string, unknown>;
}
function publicBound(value: unknown): void {
  validatePublicValue(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1048576) throw new Error("RESULT_TOO_LARGE");
}
export class ReadApplication {
  readonly registry: Registry;
  readonly #images: Images;
  readonly #broker: ReadBroker;
  readonly #maintenance: MaintenanceConfiguration;
  readonly #url: string;
  private constructor(images: Images, registry: Registry, url: string, maintenance: MaintenanceConfiguration) {
    this.registry = registry; this.#images = images; this.#maintenance = maintenance; this.#url = url;
    this.#broker = new ReadBroker({ url, tables: registry.tables, maintenance });
  }
  static async open(images: Images, url: string, maintenance: MaintenanceConfiguration = {}): Promise<ReadApplication> {
    const admission = await MaintenanceLease.acquire(url, false, maintenance);
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    const session = randomUUID();
    try {
      worker = await startWorker(images);
      const result = record(await worker.run({ mode: "register", session }, () => { throw new Error("REQUEST_DENIED"); }));
      if (result.kind !== "complete" || result.session !== session || result.sequence !== 0 || Object.keys(result).length !== 4) throw new Error("SOURCE_REJECTED");
      return new ReadApplication(images, restoreManifest(result.value), url, maintenance);
    } finally { try { await worker?.close(); } finally { await admission.close(); } }
  }
  async #execute(worker: Awaited<ReturnType<typeof startWorker>>, command: Record<string, unknown>, db?: ReadDb, budgetMs = 5000): Promise<unknown> {
    const session = randomUUID();
    let sequence = 0, admitted = false;
    let operationFault: unknown;
    const result = record(await worker.run({ ...command, session }, async input => {
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
        else if (request.kind === "query" && command.mode === "render" && !db) {
          const query = record(request.value);
          if (Object.keys(query).length !== 2 || typeof query.name !== "string") throw new Error("REQUEST_DENIED");
          value = await this.query(query.name, query.input);
        } else if (request.kind === "log" && (command.mode === "query" || command.mode === "mutation")) {
          const log = record(request.value);
          if (Object.keys(log).length !== 2 || !["info", "warn"].includes(String(log.level)) || typeof log.message !== "string" || log.message.length > 1024) throw new Error("REQUEST_DENIED");
          value = null;
        } else throw new Error("REQUEST_DENIED");
        publicBound(value);
        return { session, sequence: request.sequence, value };
      } catch (error) {
        if (command.mode === "mutation") operationFault ??= error;
        if (error instanceof PublicOperationError) return { session, sequence: request.sequence, error: error.code, ...(error.details === undefined ? {} : { details: error.details }) };
        const code = error instanceof Error && ["REQUEST_DENIED", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE"].includes(error.message) ? error.message : "INTERNAL_FAILURE";
        return { session, sequence: request.sequence, error: code };
      }
    }, budgetMs));
    if (operationFault) throw operationFault;
    if (!admitted || result.session !== session || result.sequence !== sequence || Object.keys(result).some(key => !["kind", "session", "sequence", "value", "code", "details"].includes(key))) throw new Error("REQUEST_DENIED");
    if (result.kind === "failure") {
      if (["INPUT_INVALID", "NOT_FOUND", "CONSTRAINT_CONFLICT", "VERSION_CONFLICT", "UNSUPPORTED_CAPABILITY"].includes(String(result.code))) throw new PublicOperationError(result.code as DeclaredErrorCode, result.details);
      const code = typeof result.code === "string" && ["REQUEST_DENIED", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "ROUTE_INVALID", "ROUTE_NOT_FOUND", "UNSUPPORTED_CAPABILITY"].includes(result.code) ? result.code : "INTERNAL_FAILURE";
      throw new Error(code);
    }
    if (result.kind !== "complete" || Object.keys(result).length !== 4 || !Object.hasOwn(result, "value")) throw new Error("REQUEST_DENIED");
    publicBound(result.value);
    return result.value;
  }
  async query(name: string, rawInput: unknown): Promise<unknown> {
    const operation = this.registry.queries.get(name);
    if (!operation) throw new Error("REQUEST_DENIED");
    let input: unknown;
    try { input = operation.input.parse(rawInput); } catch { throw new PublicOperationError("INPUT_INVALID"); }
    const worker = await startWorker(this.#images);
    try {
      return await this.#broker.read(async (db, remaining) => operation.output.parse(await this.#execute(worker, { mode: "query", operation: name, input }, db, remaining())), queryIdentity(name, operation.input, input));
    } finally { await worker.close(); }
  }
  async mutate(name: string, rawInput: unknown): Promise<unknown> {
    const operation = this.registry.mutations.get(name);
    if (!operation) throw new Error("REQUEST_DENIED");
    let input: unknown;
    try { input = operation.input.parse(rawInput); } catch { throw new PublicOperationError("INPUT_INVALID"); }
    const worker = await startWorker(this.#images);
    // Worker retirement is verified before output reaches COMMIT. Close cannot
    // change a confirmed commit's outcome.
    let retired = false;
    try {
      return await this.#broker.mutate(async (db, remaining) => {
        const result = operation.output.parse(await this.#execute(worker, { mode: "mutation", operation: name, input }, db, remaining()));
        await worker.close();
        retired = true;
        return result;
      }, { operation: name, input });
    } finally {
      if (!retired) await worker.close().catch(() => { /* The durable worker lease retains cleanup evidence; preserve the transaction outcome. */ });
    }
  }
  async render(path: string): Promise<PageResult> {
    const admission = await MaintenanceLease.acquire(this.#url, false, this.#maintenance);
    try { return await this.#render(path); } finally { await admission.close(); }
  }
  async #render(path: string): Promise<PageResult> {
    // Route validation also runs in the trusted host before application entry.
    try {
      if (!selectPage([...this.registry.pages.values()], path)) throw new Error("ROUTE_NOT_FOUND");
    } catch (error) { throw new Error(error instanceof Error && error.message === "ROUTE_NOT_FOUND" ? error.message : "ROUTE_INVALID"); }
    const worker = await startWorker(this.#images);
    try {
      const result = record(await this.#execute(worker, { mode: "render", path }));
      if (Object.keys(result).length !== 2 || typeof result.html !== "string" || !Array.isArray(result.islands) || result.islands.length > 500) throw new Error("INTERNAL_FAILURE");
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
    } finally { await worker.close(); }
  }
  async close(): Promise<void> { await this.#broker.close(); }
}
