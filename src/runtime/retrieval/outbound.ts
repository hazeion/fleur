import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { validatePublicValue } from "../../schema";
import { description } from "../schema-descriptions";
import { classifyAddress } from "./addresses";
import { RetrievalError, destinationOrigin, expandPath, queryParameters, validateDestination, type DestinationDefinition } from "./destinations";
import { selectDeclared } from "./selection";

/**
 * A credential binding is trusted startup configuration. The secret is attached
 * only to requests for destinations declared on exactly this origin.
 */
export interface CredentialBinding {
  readonly origin: string;
  /** Request header carrying the value, for example `authorization`. */
  readonly header?: string;
  /** Query parameter carrying the value, for providers that require one. */
  readonly query?: string;
  readonly value: string;
}
/** Trusted host configuration. Application code and browser input never supply it. */
export interface RetrievalConfiguration {
  /** Whole-operation deadline: default 10 000 ms, at most 30 000 ms. */
  readonly timeoutMs?: number;
  /** Decoded response-body limit: default 1 MiB, at most 10 MiB. */
  readonly maxBytes?: number;
  readonly credentials?: Readonly<Record<string, CredentialBinding>>;
  /** Exact local development/test origins that may use HTTP and loopback or private addresses. */
  readonly localServices?: readonly string[];
  /** Additional trusted PEM certificate authorities. */
  readonly certificateAuthorities?: readonly string[];
  /** Host resolution; defaults to the operating system resolver. */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}
export interface ExternalResult { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body?: unknown; }
export const DEFAULT_TIMEOUT_MS = 10_000, MAX_TIMEOUT_MS = 30_000, DEFAULT_MAX_BYTES = 1048576, MAX_BYTES = 10 * 1048576;
const invalid = (): never => { throw new Error("CONFIGURATION_INVALID"); };
const deny = (): never => { throw new RetrievalError("RETRIEVAL_DESTINATION_DENIED"); };
async function systemResolve(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(entry => entry.address);
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return invalid();
  return value;
}

/** Trusted host broker for declared external destinations. */
export class OutboundBroker {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly #destinations: ReadonlyMap<string, DestinationDefinition>;
  readonly #credentials: ReadonlyMap<string, CredentialBinding>;
  readonly #local: ReadonlySet<string>;
  readonly #ca: string[] | undefined;
  readonly #resolve: (hostname: string) => Promise<readonly string[]>;
  constructor(destinations: ReadonlyMap<string, DestinationDefinition>, configuration: RetrievalConfiguration = {}) {
    this.timeoutMs = limit(configuration.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.maxBytes = limit(configuration.maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES);
    const local = new Set<string>();
    for (const origin of configuration.localServices ?? []) { try { local.add(destinationOrigin(origin).origin); } catch { invalid(); } }
    const credentials = new Map<string, CredentialBinding>();
    for (const [name, binding] of Object.entries(configuration.credentials ?? {})) {
      if (!binding || typeof binding !== "object" || typeof binding.value !== "string" || !binding.value || /[\r\n\0]/.test(binding.value) || (binding.header === undefined) === (binding.query === undefined)) invalid();
      if (binding.header !== undefined && !/^[a-z0-9-]{1,64}$/.test(binding.header)) invalid();
      if (binding.query !== undefined && !/^[A-Za-z0-9._~-]{1,128}$/.test(binding.query)) invalid();
      try { destinationOrigin(binding.origin); } catch { invalid(); }
      credentials.set(name, Object.freeze({ ...binding }));
    }
    for (const destination of destinations.values()) {
      try { validateDestination(destination); description(destination.response); } catch { invalid(); }
      if (destination.credential === undefined) continue;
      const binding = credentials.get(destination.credential);
      if (!binding) throw new Error("CONFIGURATION_MISSING");
      // An application names a binding; it cannot carry the secret to another origin
      // or read back the header that carries it.
      if (binding.origin !== destination.origin || (binding.header !== undefined && destination.headers.includes(binding.header))) invalid();
    }
    this.#destinations = destinations; this.#credentials = credentials; this.#local = local;
    this.#ca = configuration.certificateAuthorities?.length ? [...configuration.certificateAuthorities] : undefined;
    this.#resolve = configuration.resolveHost ?? systemResolve;
  }
  /** The absolute deadline for an operation starting now. */
  deadline(): number { return performance.now() + this.timeoutMs; }
  /**
   * Performs one declared GET or HEAD before `deadline`, an absolute
   * `performance.now()` value shared by every phase. Failures are RetrievalErrors.
   */
  async request(raw: unknown, deadline: number): Promise<ExternalResult> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny();
    const request = raw as Record<string, unknown>;
    if (Object.keys(request).length !== 4 || typeof request.destination !== "string" || !["GET", "HEAD"].includes(String(request.method))) return deny();
    const destination = this.#destinations.get(request.destination);
    if (!destination) return deny();
    const method = request.method as "GET" | "HEAD";
    const binding = destination.credential === undefined ? undefined : this.#credentials.get(destination.credential);
    let path: string, query: [string, string][];
    try { path = expandPath(destination.path, request.params); query = queryParameters(request.query, binding?.query); }
    catch { return deny(); }
    const origin = destinationOrigin(destination.origin);
    const local = this.#local.has(origin.origin);
    if (origin.protocol !== "https:" && !local) return deny();
    if (binding?.query !== undefined) query.push([binding.query, binding.value]);
    const search = query.length ? "?" + new URLSearchParams(query).toString() : "";

    const controller = new AbortController();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new RetrievalError("RETRIEVAL_TIMEOUT");
    let expired = false;
    const timer = setTimeout(() => { expired = true; controller.abort(); }, remaining);
    const timeout = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new RetrievalError("RETRIEVAL_TIMEOUT")), { once: true }));
    timeout.catch(() => {});
    const failed = (error: unknown): never => {
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError(expired ? "RETRIEVAL_TIMEOUT" : "RETRIEVAL_TRANSPORT_FAILURE");
    };
    let response: Response | undefined;
    try {
      // Resolve once and connect to that admitted address. The hostname is
      // never resolved again, so a rebinding answer cannot change the peer.
      const hostname = origin.hostname.replace(/^\[|\]$/g, "");
      const literal = isIP(hostname) !== 0;
      let addresses: readonly string[];
      try { addresses = literal ? [hostname] : await Promise.race([this.#resolve(hostname), timeout]); }
      catch (error) { return failed(error); }
      if (!Array.isArray(addresses) || !addresses.length) throw new RetrievalError("RETRIEVAL_TRANSPORT_FAILURE");
      for (const address of addresses) {
        let kind;
        try { kind = classifyAddress(address); } catch { return deny(); }
        if (kind !== "public" && !(local && (kind === "loopback" || kind === "private"))) return deny();
      }
      const address = addresses[0]!;
      const target = `${origin.protocol}//${isIP(address) === 6 ? `[${address}]` : address}:${origin.port || (origin.protocol === "https:" ? 443 : 80)}${path}${search}`;
      const headers: Record<string, string> = { host: origin.host, accept: "application/json" };
      if (binding?.header !== undefined) headers[binding.header] = binding.value;
      try {
        response = await Promise.race([fetch(target, {
          // Proxy environment variables never select the peer or receive credentials.
          method, headers, redirect: "manual", signal: controller.signal, keepalive: false, proxy: false,
          ...(origin.protocol === "https:" ? { tls: { ...(literal ? {} : { serverName: hostname }), ...(this.#ca ? { ca: this.#ca } : {}) } } : {}),
        }), timeout]);
      } catch (error) { return failed(error); }
      if (response.status >= 300 && response.status < 400) throw new RetrievalError("RETRIEVAL_REDIRECT_DENIED", response.status);
      if (response.status < 200 || response.status >= 300) throw new RetrievalError("RETRIEVAL_HTTP_FAILURE", response.status);
      // A provider echoing the bound secret cannot pass it to application code,
      // through a declared header or the body. Only literal copies are detected.
      const echoes = (text: string) => binding !== undefined && (text.includes(binding.value) || text.includes(JSON.stringify(binding.value).slice(1, -1)));
      const exposed: Record<string, string> = {};
      for (const name of destination.headers) {
        const value = response.headers.get(name);
        if (value !== null && echoes(value)) throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT");
        if (value !== null && value.length <= 1024) exposed[name] = value;
      }
      if (method === "HEAD") return Object.freeze({ status: response.status, headers: exposed });
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > this.maxBytes) throw new RetrievalError("RETRIEVAL_TOO_LARGE");
      // Count decoded bytes as they stream; Content-Length alone is insufficient.
      const bytes = await this.#read(response, timeout, failed);
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT"); }
      let body: unknown;
      try { body = destination.response.parse(selectDeclared(description(destination.response), parsed)); }
      catch { throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT"); }
      const encoded = JSON.stringify(body);
      if (echoes(encoded)) throw new RetrievalError("RETRIEVAL_INVALID_OUTPUT");
      // Retrieved data crosses the worker channel under the public value limit.
      validatePublicValue(body);
      if (new TextEncoder().encode(encoded).byteLength > 1048576) throw new RetrievalError("RETRIEVAL_TOO_LARGE");
      return Object.freeze({ status: response.status, headers: exposed, body });
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
      controller.abort();
    }
  }
  async #read(response: Response, timeout: Promise<never>, failed: (error: unknown) => never): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        let next: Awaited<ReturnType<typeof reader.read>>;
        try { next = await Promise.race([reader.read(), timeout]); } catch (error) { return failed(error); }
        if (next.done) break;
        size += next.value.byteLength;
        if (size > this.maxBytes) throw new RetrievalError("RETRIEVAL_TOO_LARGE");
        chunks.push(next.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
}
/**
 * Reads credential bindings from the trusted startup environment:
 * FLEUR_RETRIEVAL_CREDENTIALS holds a JSON object mapping each binding name to
 * `{ origin, header | query, value }`. Failures never include the content.
 */
export function credentialsFromEnvironment(environment: Readonly<Record<string, string | undefined>>): Record<string, CredentialBinding> {
  const text = environment.FLEUR_RETRIEVAL_CREDENTIALS;
  if (text === undefined || text === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid();
  for (const binding of Object.values(parsed)) if (!binding || typeof binding !== "object" || Array.isArray(binding)) return invalid();
  return parsed as Record<string, CredentialBinding>;
}
