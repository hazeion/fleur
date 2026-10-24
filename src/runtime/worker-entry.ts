import { validatePublicValue } from "../schema";
import { executePage, executeQuery } from "./worker-execution";
import { workerManifest } from "./worker-manifest";
import { workerReadDb } from "./read-wire";
import { PublicOperationError, type DeclaredErrorCode } from "../server";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REQUEST_DENIED");
  return value as Record<string, unknown>;
}
export function makeRunner(exports: Readonly<Record<string, unknown>>) {
  return async (request: unknown, transport: (request: unknown) => unknown) => {
    const command = record(request);
    if (typeof command.session !== "string" || !/^[a-f0-9-]{36}$/.test(command.session)) throw new Error("REQUEST_DENIED");
    const manifest = workerManifest(exports);
    let sequence = 0;
    const exchange = (kind: string, value: unknown): unknown => {
      validatePublicValue(value);
      const current = sequence++;
      const result = record(transport({ kind, session: command.session, sequence: current, value }));
      if (result.session !== command.session || result.sequence !== current || Object.keys(result).some(key => !["session", "sequence", "value", "error", "details"].includes(key))) throw new Error("REQUEST_DENIED");
      if (result.error !== undefined) {
        if (["INPUT_INVALID", "NOT_FOUND", "CONSTRAINT_CONFLICT", "VERSION_CONFLICT", "UNSUPPORTED_CAPABILITY"].includes(String(result.error))) throw new PublicOperationError(result.error as DeclaredErrorCode, result.details);
        throw new Error(typeof result.error === "string" ? result.error : "INTERNAL_FAILURE");
      }
      return result.value;
    };
    try {
      let value: unknown;
      if (command.mode === "register") value = manifest;
      else {
        exchange("registry", manifest);
        if (command.mode === "query" && typeof command.operation === "string") {
          let logs = 0;
          const log = (level: string, message: string) => {
            if (typeof message !== "string" || message.length > 1024 || ++logs > 50) throw new Error("QUERY_LIMIT");
            exchange("log", { level, message });
          };
          value = await executeQuery(command.operation, command.input, workerReadDb(request => exchange("read", request)), { info: message => log("info", message), warn: message => log("warn", message) });
        } else if (command.mode === "render" && typeof command.path === "string") {
          value = await executePage(command.path, async (name, input) => exchange("query", { name, input }));
        } else throw new Error("REQUEST_DENIED");
      }
      validatePublicValue(value);
      if (new TextEncoder().encode(JSON.stringify(value)).length > 1048576) throw new Error("RESULT_TOO_LARGE");
      return { kind: "complete", session: command.session, sequence, value };
    } catch (error) {
      if (error instanceof PublicOperationError) return { kind: "failure", session: command.session, sequence, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) };
      const allowed = ["QUERY_LIMIT", "QUERY_TIMEOUT", "RESULT_TOO_LARGE", "REQUEST_DENIED", "ROUTE_INVALID", "ROUTE_NOT_FOUND", "UNSUPPORTED_CAPABILITY"];
      const code = error instanceof Error && allowed.includes(error.message) ? error.message : "INTERNAL_FAILURE";
      return { kind: "failure", session: command.session, sequence, code };
    }
  };
}
