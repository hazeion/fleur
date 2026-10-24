import type { ComponentChild } from "preact";
import type { Page } from "../routing";
import type { Query, Schema } from "../schema";
import type { ReadDb } from "../database";

export interface SafeLog { info(message: string): void; warn(message: string): void; }
export interface QueryRegistration { contract: Query; handler(context: { input: unknown; db: ReadDb; log: SafeLog }): Promise<unknown>; }
export interface PageRegistration { contract: Page; component(params: unknown): Promise<ComponentChild>; }
export const queries = new Map<Query, QueryRegistration>();
export const pages = new Map<Page, PageRegistration>();
export const queryNames = new Map<Query, string>();
export const pageNames = new Map<Page, string>();
export const exportedSchemas = new Map<string, Schema>();
export type Execution =
  | { kind: "query"; db: ReadDb; log: SafeLog }
  | { kind: "render"; read(name: string, input: unknown): Promise<unknown> };
let execution: Execution | undefined;
export function currentExecution(): Execution | undefined { return execution; }
export async function withExecution<T>(context: Execution, run: () => Promise<T>): Promise<T> {
  if (execution) throw new Error("REQUEST_DENIED");
  execution = context;
  try { return await run(); } finally { execution = undefined; }
}
