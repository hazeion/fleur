import { defineMutation, validatePublicValue, type Mutation } from "../schema";
export interface MutationError { readonly code: string; readonly details?: unknown; }
export type MutationOutcome<T> =
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "failure"; readonly delivery: "not-sent" | "submitted"; readonly error: MutationError }
  | { readonly status: "outcome-unknown" };
export interface MutationTransport { send(path: string, init: RequestInit): Promise<Response>; online(): boolean; }
const names = new WeakMap<object, string>();
let browserTransport: MutationTransport | undefined;
export function installMutationTransport(transport: MutationTransport): void {
  if (browserTransport) throw new Error("Transport already installed");
  browserTransport = Object.freeze(transport);
}
export function nameMutationExports(exports: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(exports).sort(([a], [b]) => a.localeCompare(b))) {
    if (value && typeof value === "object" && "kind" in value && value.kind === "mutation" && !names.has(value)) names.set(value, name);
  }
}
const codes = new Set(["INPUT_INVALID", "NOT_FOUND", "CONSTRAINT_CONFLICT", "VERSION_CONFLICT", "UNSUPPORTED_CAPABILITY", "QUERY_TIMEOUT", "QUERY_LIMIT", "RESULT_TOO_LARGE", "REQUEST_DENIED", "INTERNAL_FAILURE", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SCHEMA_DRIFT", "MIGRATIONS_PENDING"]);
async function responseJSON(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body) throw new Error("Invalid response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > 1048576) throw new Error("Response too large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export async function runMutation<I, O>(contract: Mutation<I, O>, raw: NoInfer<I>, transport = browserTransport): Promise<MutationOutcome<O>> {
  // Invalid contract objects are programmer errors, not ordinary mutation outcomes.
  defineMutation({ input: contract.input, output: contract.output, ...(contract.name === undefined ? {} : { name: contract.name }) });
  if (contract.kind !== "mutation") throw new Error("Invalid mutation");
  let body: string;
  const failure = (code: string): MutationOutcome<O> => ({ status: "failure", delivery: "not-sent", error: { code } });
  try {
    const input = contract.input.parse(raw);
    body = JSON.stringify({ name: contract.name ?? names.get(contract), input });
    if (!contract.name && !names.has(contract)) return failure("REQUEST_DENIED");
    if (new TextEncoder().encode(body).length > 1048576) return failure("QUERY_LIMIT");
  } catch { return failure("INPUT_INVALID"); }
  if (!transport || !transport.online()) return failure("NOT_SENT");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    // Once send is called, transport errors cannot prove non-delivery.
    const response = await transport.send("/__fleur/mutation", { method: "POST", headers: { "Content-Type": "application/json", "X-Fleur-Request": "mutation" }, body, signal: abort.signal, credentials: "same-origin", redirect: "error", cache: "no-store" });
    const rawResult = await responseJSON(response);
    validatePublicValue(rawResult);
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new Error("Invalid outcome");
    const result = rawResult as Record<string, unknown>;
    if (result.status === "success" && Object.keys(result).length === 2 && Object.hasOwn(result, "data") && response.ok) return { status: "success", data: contract.output.parse(result.data) };
    if (result.status === "outcome-unknown" && Object.keys(result).length === 1) return { status: "outcome-unknown" };
    if (result.status === "failure" && Object.keys(result).length === 2 && result.error && typeof result.error === "object" && !Array.isArray(result.error)) {
      const error = result.error as Record<string, unknown>;
      if (Object.keys(error).some(key => !["code", "details"].includes(key)) || typeof error.code !== "string" || !codes.has(error.code) || JSON.stringify(error).length > 8192) throw new Error("Invalid error");
      return { status: "failure", delivery: "submitted", error: { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) } };
    }
    throw new Error("Invalid outcome");
  } catch { return { status: "outcome-unknown" }; }
  finally { clearTimeout(timer); }
}
