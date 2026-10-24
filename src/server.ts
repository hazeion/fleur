import type { VNode } from "preact";
import { defineQuery, defineMutation, type Mutation, type Query, validatePublicValue } from "./schema";
import { definePage, type Page } from "./routing";
import type { ReadDb, WriteDb } from "./database";
import { currentExecution, pages, queries, queryNames, mutations, mutationNames, type SafeLog } from "./runtime/registrations";

export type { SafeLog };
export function handleQuery<I, O>(contract: Query<I, O>, handler: (context: { input: NoInfer<I>; db: ReadDb; log: SafeLog }) => Promise<NoInfer<O>>): void {
  defineQuery({ ...(contract.name === undefined ? {} : { name: contract.name }), input: contract.input, output: contract.output });
  if (contract.kind !== "query" || typeof handler !== "function" || queries.has(contract) || (contract.name && [...queries.keys(), ...mutations.keys()].some(query => query.name === contract.name))) throw new Error("Duplicate or invalid query");
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
  if (contract.kind !== "mutation" || typeof handler !== "function" || mutations.has(contract) || (contract.name && [...mutations.keys(), ...queries.keys()].some(operation => operation.name === contract.name))) throw new Error("Duplicate or invalid mutation");
  mutations.set(contract, Object.freeze({ contract, handler: async (context: { input: unknown; db: WriteDb; log: SafeLog }) => {
    const input = contract.input.parse(context.input);
    return contract.output.parse(await handler({ ...context, input }));
  } }));
  if (contract.name) mutationNames.set(contract, contract.name);
}
