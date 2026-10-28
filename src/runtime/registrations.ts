import type { ComponentChild } from "preact";
import type { Page } from "../routing";
import type { Query, Mutation, Retrieval, Schema } from "../schema";
import type { DestinationDefinition } from "./retrieval/destinations";
import type { ReadDb, WriteDb } from "../database";

export interface SafeLog { info(message: string): void; warn(message: string): void; }
export interface QueryRegistration { contract: Query; handler(context: { input: unknown; db: ReadDb; log: SafeLog }): Promise<unknown>; }
export interface PageRegistration { contract: Page; component(params: unknown): Promise<ComponentChild>; }
export interface MutationRegistration { contract: Mutation; handler(context: { input: unknown; db: WriteDb; log: SafeLog }): Promise<unknown>; }
export interface RetrievalRegistration { contract: Retrieval; handler(context: { input: unknown; external: unknown; log: SafeLog }): Promise<unknown>; }
export const retrievals = new Map<Retrieval, RetrievalRegistration>();
export const retrievalNames = new Map<Retrieval, string>();
export const destinations = new Map<object, DestinationDefinition & { readonly name?: string }>();
export const destinationNames = new Map<object, string>();
export const mutations = new Map<Mutation, MutationRegistration>();
export const mutationNames = new Map<Mutation, string>();
export const queries = new Map<Query, QueryRegistration>();
export const pages = new Map<Page, PageRegistration>();
export const queryNames = new Map<Query, string>();
export const pageNames = new Map<Page, string>();
export const exportedSchemas = new Map<string, Schema>();
export type Execution =
  | { kind: "mutation"; db: WriteDb; log: SafeLog }
  | { kind: "query"; db: ReadDb; log: SafeLog }
  | { kind: "retrieval"; external(request: unknown): Promise<unknown>; log: SafeLog }
  | { kind: "render"; read(name: string, input: unknown): Promise<unknown>; retrieve(name: string, input: unknown): Promise<unknown> };
let execution: Execution | undefined;
export function currentExecution(): Execution | undefined { return execution; }
export async function withExecution<T>(context: Execution, run: () => Promise<T>): Promise<T> {
  if (execution) throw new Error("REQUEST_DENIED");
  execution = context;
  try { return await run(); } finally { execution = undefined; }
}
