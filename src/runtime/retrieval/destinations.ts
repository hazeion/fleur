import type { Schema } from "../../schema";

/**
 * A declared external destination. Declarations are application source, but
 * the trusted host enforces them; nothing here grants network authority.
 */
export interface DestinationDefinition {
  readonly origin: string;
  readonly path: string;
  readonly response: Schema;
  readonly headers: readonly string[];
  readonly credential?: string;
}
export type RetrievalFailureCode =
  | "RETRIEVAL_DESTINATION_DENIED" | "RETRIEVAL_REDIRECT_DENIED" | "RETRIEVAL_TIMEOUT" | "RETRIEVAL_HTTP_FAILURE"
  | "RETRIEVAL_TRANSPORT_FAILURE" | "RETRIEVAL_TOO_LARGE" | "RETRIEVAL_INVALID_OUTPUT";
export const retrievalFailureCodes: readonly RetrievalFailureCode[] = Object.freeze([
  "RETRIEVAL_DESTINATION_DENIED", "RETRIEVAL_REDIRECT_DENIED", "RETRIEVAL_TIMEOUT", "RETRIEVAL_HTTP_FAILURE",
  "RETRIEVAL_TRANSPORT_FAILURE", "RETRIEVAL_TOO_LARGE", "RETRIEVAL_INVALID_OUTPUT",
]);
/** A safe typed retrieval failure. Details carry at most the provider's HTTP status. */
export class RetrievalError extends Error {
  readonly status?: number;
  constructor(readonly code: RetrievalFailureCode, status?: number) {
    super(code);
    if (!retrievalFailureCodes.includes(code) || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))) throw new Error("Invalid retrieval error");
    if (status !== undefined) this.status = status;
  }
  get details(): { status: number } | undefined { return this.status === undefined ? undefined : { status: this.status }; }
}
/** Response metadata that may carry credentials or session state is never exposed. */
const withheldHeaders = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "set-cookie2", "proxy-authenticate", "www-authenticate"]);
const segment = /^(?:[A-Za-z0-9._~-]+|:[a-zA-Z][a-zA-Z0-9_]*)$/;
const denied = (): never => { throw new Error("Invalid destination"); };

/** Accepts only a canonical scheme://host[:port] origin without credentials, path, query or fragment. */
export function destinationOrigin(origin: unknown): URL {
  if (typeof origin !== "string" || origin.length > 2048) return denied();
  let url: URL;
  try { url = new URL(origin); } catch { return denied(); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.origin !== origin) return denied();
  return url;
}
export function pathKeys(path: string): string[] {
  return path.split("/").filter(part => part.startsWith(":")).map(part => part.slice(1));
}
export function validateDestination(spec: { origin: unknown; path: unknown; headers: unknown; credential?: unknown }): void {
  destinationOrigin(spec.origin);
  const path = spec.path;
  if (typeof path !== "string" || path.length > 2048 || !path.startsWith("/")) return denied();
  const parts = path.slice(1).split("/");
  if (path !== "/" && parts.some((part, index) => !(segment.test(part) || (part === "" && index === parts.length - 1)) || part === "." || part === "..")) return denied();
  const keys = pathKeys(path);
  if (new Set(keys).size !== keys.length) return denied();
  if (!Array.isArray(spec.headers) || spec.headers.length > 16 || new Set(spec.headers).size !== spec.headers.length) return denied();
  for (const name of spec.headers) if (typeof name !== "string" || !/^[a-z0-9-]{1,64}$/.test(name) || withheldHeaders.has(name)) return denied();
  if (spec.credential !== undefined && (typeof spec.credential !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(spec.credential))) return denied();
}
/** Expands a declared path template; each parameter is exactly one encoded segment. */
export function expandPath(template: string, params: unknown): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("RETRIEVAL_DESTINATION_DENIED");
  const values = params as Record<string, unknown>;
  const keys = pathKeys(template);
  if (Object.keys(values).length !== keys.length || Object.keys(values).some(key => !keys.includes(key))) throw new Error("RETRIEVAL_DESTINATION_DENIED");
  return template.split("/").map(part => {
    if (!part.startsWith(":")) return part;
    const value = values[part.slice(1)];
    if (typeof value !== "string" || !value.length || value.length > 1024 || value === "." || value === "..") throw new Error("RETRIEVAL_DESTINATION_DENIED");
    return encodeURIComponent(value);
  }).join("/");
}
export function queryParameters(query: unknown, reserved?: string): [string, string][] {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("RETRIEVAL_DESTINATION_DENIED");
  const entries = Object.entries(query as Record<string, unknown>);
  if (entries.length > 32) throw new Error("RETRIEVAL_DESTINATION_DENIED");
  return entries.map(([key, value]) => {
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(key) || key === reserved || typeof value !== "string" || value.length > 2048) throw new Error("RETRIEVAL_DESTINATION_DENIED");
    return [key, value];
  });
}
