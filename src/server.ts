import type { VNode } from "preact";
import { defineQuery, defineMutation, defineRetrieval, type Mutation, type Query, type Retrieval, type Schema, validatePublicValue } from "./schema";
import { definePage, type Page } from "./routing";
import type { ReadDb, WriteDb } from "./database";
import { currentExecution, pages, queries, queryNames, mutations, mutationNames, retrievals, retrievalNames, destinations, destinationNames, type SafeLog } from "./runtime/registrations";
import { validators } from "./runtime/schema-metadata";
import { RetrievalError, validateDestination, type RetrievalFailureCode } from "./runtime/retrieval/destinations";

export type { SafeLog, RetrievalFailureCode };
export { RetrievalError };
const registeredNames = (): (string | undefined)[] => [...queries.keys(), ...mutations.keys(), ...retrievals.keys()].map(operation => operation.name);
export function handleQuery<I, O>(contract: Query<I, O>, handler: (context: { input: NoInfer<I>; db: ReadDb; log: SafeLog }) => Promise<NoInfer<O>>): void {
  defineQuery({ ...(contract.name === undefined ? {} : { name: contract.name }), input: contract.input, output: contract.output });
  if (contract.kind !== "query" || typeof handler !== "function" || queries.has(contract) || (contract.name && registeredNames().includes(contract.name))) throw new Error("Duplicate or invalid query");
  queries.set(contract, Object.freeze({ contract, handler: async (context: { input: unknown; db: ReadDb; log: SafeLog }) => {
    const input = contract.input.parse(context.input);
    const output = await handler({ ...context, input });
    return contract.output.parse(output);
  } }));
  if (contract.name) queryNames.set(contract, contract.name);
}
export async function readQuery<I, O>(contract: Query<I, O>, input: NoInfer<I>): Promise<O> {
  const execution = currentExecution();
  const name = queryNames.get(contract);
  if (execution?.kind !== "render") throw new Error("UNSUPPORTED_CAPABILITY");
  if (!name || !queries.has(contract)) throw new Error("REQUEST_DENIED");
  return contract.output.parse(await execution.read(name, contract.input.parse(input)));
}
export function registerPage<P>(contract: Page<P>, options: { component(props: { params: NoInfer<P> }): VNode | Promise<VNode> }): void {
  definePage(contract as never);
  const normalized = contract.path.replace(/:[^/]+/g, ":parameter");
  if (pages.has(contract) || [...pages.keys()].some(page => page.path.replace(/:[^/]+/g, ":parameter") === normalized)) throw new Error("Duplicate page");
  const component = options.component;
  if (typeof component !== "function") throw new Error("Invalid page component");
  pages.set(contract, Object.freeze({ contract, component: async (params: unknown) => component({ params: contract.params.parse(params) }) }));
}
export type DeclaredErrorCode = "INPUT_INVALID" | "NOT_FOUND" | "CONSTRAINT_CONFLICT" | "VERSION_CONFLICT" | "UNSUPPORTED_CAPABILITY";
export class PublicOperationError extends Error {
  constructor(readonly code: DeclaredErrorCode, readonly details?: unknown) {
    super(code);
    if (!["INPUT_INVALID", "NOT_FOUND", "CONSTRAINT_CONFLICT", "VERSION_CONFLICT", "UNSUPPORTED_CAPABILITY"].includes(code)) throw new Error("Invalid public error");
    if (details !== undefined) {
      validatePublicValue(details);
      if (JSON.stringify(details).length > 4096) throw new Error("Public error exceeds limit");
    }
  }
}
export function inputError(fields: Record<string, string>): PublicOperationError {
  if (Object.values(fields).some(value => typeof value !== "string")) throw new Error("Invalid field errors");
  return new PublicOperationError("INPUT_INVALID", fields);
}
export function publicError(code: DeclaredErrorCode, details?: unknown): PublicOperationError { return new PublicOperationError(code, details); }

export function handleMutation<I, O>(contract: Mutation<I, O>, handler: (context: { input: NoInfer<I>; db: WriteDb; log: SafeLog }) => Promise<NoInfer<O>>): void {
  defineMutation({ ...(contract.name === undefined ? {} : { name: contract.name }), input: contract.input, output: contract.output });
  if (contract.kind !== "mutation" || typeof handler !== "function" || mutations.has(contract) || (contract.name && registeredNames().includes(contract.name))) throw new Error("Duplicate or invalid mutation");
  mutations.set(contract, Object.freeze({ contract, handler: async (context: { input: unknown; db: WriteDb; log: SafeLog }) => {
    const input = contract.input.parse(context.input);
    return contract.output.parse(await handler({ ...context, input }));
  } }));
  if (contract.name) mutationNames.set(contract, contract.name);
}

type PathKeys<S extends string> = S extends `${string}:${infer Key}/${infer Rest}` ? Key | PathKeys<`/${Rest}`> : S extends `${string}:${infer Key}` ? Key : never;
/**
 * A declared external destination: one origin (scheme, host and port) and one
 * path template. The trusted broker enforces it; declaring one grants nothing
 * to queries, mutations or the browser.
 */
export interface Destination<B = unknown, Path extends string = string> {
  readonly kind: "destination";
  readonly name?: string;
  readonly origin: string;
  readonly path: Path;
  readonly response: Schema<B>;
  readonly headers: readonly string[];
  readonly credential?: string;
}
export type ExternalRequest<Path extends string> = [PathKeys<Path>] extends [never]
  ? { readonly params?: Readonly<Record<string, never>>; readonly query?: Readonly<Record<string, string>> }
  : { readonly params: Readonly<Record<PathKeys<Path>, string>>; readonly query?: Readonly<Record<string, string>> };
type ExternalArguments<Path extends string> = [PathKeys<Path>] extends [never] ? [request?: ExternalRequest<Path>] : [request: ExternalRequest<Path>];
export interface ExternalMetadata { readonly status: number; readonly headers: Readonly<Record<string, string>>; }
export interface ExternalResponse<B> extends ExternalMetadata { readonly body: B; }
/** Fleur-owned network authority, supplied only to retrieval handlers. */
export interface ExternalCapability {
  get<B, Path extends string>(destination: Destination<B, Path>, ...request: ExternalArguments<Path>): Promise<ExternalResponse<B>>;
  head<B, Path extends string>(destination: Destination<B, Path>, ...request: ExternalArguments<Path>): Promise<ExternalMetadata>;
}
export function defineDestination<const Path extends string, B>(options: { name?: string; origin: string; path: Path; response: Schema<B>; headers?: readonly string[]; credential?: string }): Destination<B, Path> {
  if (!options || Object.keys(options).some(key => !["name", "origin", "path", "response", "headers", "credential"].includes(key))) throw new Error("Invalid destination fields");
  if (options.name !== undefined && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(options.name)) throw new Error("Invalid destination name");
  if (!validators.has(options.response)) throw new Error("Invalid destination response schema");
  const headers = Object.freeze([...(options.headers ?? [])]);
  validateDestination({ origin: options.origin, path: options.path, headers, ...(options.credential === undefined ? {} : { credential: options.credential }) });
  const destination: Destination<B, Path> = Object.freeze({
    kind: "destination", origin: options.origin, path: options.path, response: options.response, headers,
    ...(options.name === undefined ? {} : { name: options.name }), ...(options.credential === undefined ? {} : { credential: options.credential }),
  });
  destinations.set(destination, destination);
  if (options.name !== undefined) destinationNames.set(destination, options.name);
  return destination;
}
export function handleRetrieval<I, O>(contract: Retrieval<I, O>, handler: (context: { input: NoInfer<I>; external: ExternalCapability; log: SafeLog }) => Promise<NoInfer<O>>): void {
  defineRetrieval({ ...(contract.name === undefined ? {} : { name: contract.name }), input: contract.input, output: contract.output });
  if (contract.kind !== "retrieval" || typeof handler !== "function" || retrievals.has(contract) || (contract.name && registeredNames().includes(contract.name))) throw new Error("Duplicate or invalid retrieval");
  retrievals.set(contract, Object.freeze({ contract, handler: async (context: { input: unknown; external: unknown; log: SafeLog }) => {
    const input = contract.input.parse(context.input);
    const output = await handler({ ...context, input, external: context.external as ExternalCapability });
    try { return contract.output.parse(output); } catch { throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT"); }
  } }));
  if (contract.name) retrievalNames.set(contract, contract.name);
}
/**
 * Reads a retrieval's current validated value for this view during server
 * rendering. Queries, mutations and retrievals cannot dispatch retrievals.
 */
export async function readRetrieval<I, O>(contract: Retrieval<I, O>, input: NoInfer<I>): Promise<O> {
  const execution = currentExecution();
  const name = retrievalNames.get(contract);
  if (execution?.kind !== "render") throw new Error("UNSUPPORTED_CAPABILITY");
  if (!name || !retrievals.has(contract)) throw new Error("REQUEST_DENIED");
  const value = await execution.retrieve(name, contract.input.parse(input));
  try { return contract.output.parse(value); } catch { throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT"); }
}
