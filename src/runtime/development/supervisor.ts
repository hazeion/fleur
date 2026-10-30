import type { CliOutcome, Json } from "../../cli/result";
import { doctor } from "../../setup/doctor";
import { productionHost } from "../../setup/host";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { BrowserBuild } from "../build/client";
import { join } from "node:path";
import { ReadApplication } from "../application";
import { admitProject, type AdmittedProject } from "../build/admission";
import { compileClient } from "../build/client";
import { compileWorker } from "../build/worker";
import { SourceAdmissionError } from "../build/diagnostics";
import { describeDevelopmentStartup, startDevelopmentDatabase } from "../database/development";
import { databaseHealth, readinessReasons } from "../database/health";
import { MaintenanceLease, digest, privateDirectory } from "../database/maintenance";
import { restoreManifest } from "../manifest-wire";
import { startWorker } from "../native/host";
import { prepareDevelopmentImages } from "./images";
import { serveReadApplication } from "../http";
import { DevelopmentPostgres } from "./postgres";
import { adoptLock, binding, lock, monotonicNanoseconds, readState, save, startIdentity, type State } from "./state";
import { verifyDevelopmentReadiness } from "./readiness";
import { browserVersionHeaders, refuseStaleBrowser } from "./browser-version";
import { DevelopmentAssets } from "./assets";
import { publicState } from "./protocol";

type Images = Awaited<ReturnType<typeof prepareDevelopmentImages>>;
type Generation = { cancellation: AbortController; app: ReadApplication; server: ReturnType<typeof serveReadApplication>; images: Images; browser: BrowserBuild };
const safeCodes = ["READINESS_TIMEOUT", "PREREQUISITE_UNAVAILABLE", "DATABASE_UNAVAILABLE", "SCHEMA_DRIFT", "MIGRATIONS_PENDING", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED", "SOURCE_REJECTED", "PORT_OCCUPIED", "EXECUTION_RECOVERY_REQUIRED", "SOURCE_OBSOLETE", "IMAGE_RECOVERY_REQUIRED", "BROWSER_ASSET_CAPACITY", "MIGRATION_EDITED", "MIGRATION_INCOMPATIBLE", "SEED_INVALID", "SEED_CONFLICT", "CONFIGURATION_MISSING", "DATABASE_PRIVILEGE_INSUFFICIENT", "AUTHORITY_REQUIRED", "HUMAN_ACTION_REQUIRED"];
function safeCode(error: unknown): string { return error instanceof Error && safeCodes.includes(error.message) ? error.message : "INTERNAL_FAILURE"; }
/** Retain only prerequisite states; arbitrary Docker stdout/stderr is never development output. */
function prerequisiteSummary(outcome: CliOutcome): Json {
  const value = outcome.result.data;
  const raw = value && typeof value === "object" && !Array.isArray(value) && "components" in value ? value.components : null;
  const components: Record<string, Json> = {};
  const allowed = new Set(["ready", "missing", "unavailable", "unverified", "image-required", "denied", "timeout", "incompatible", "unknown", "not-checked", "failed"]);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const key of ["cli", "daemon", "compose", "smoke", "release"]) {
    const item: unknown = Object.getOwnPropertyDescriptor(raw, key)?.value;
    if (item && typeof item === "object" && !Array.isArray(item)) components[key] = { state: "state" in item && typeof item.state === "string" && allowed.has(item.state) ? item.state : "unknown", ...("cleanup" in item && typeof item.cleanup === "boolean" ? { cleanup: item.cleanup } : {}) };
  }
  const code = outcome.result.error?.code;
  return { formatVersion: 1, command: "doctor", ok: outcome.result.ok, data: { components }, error: code ? { code: safeCodes.includes(code) ? code : "PREREQUISITE_UNAVAILABLE", message: "Prerequisite readiness did not admit this runtime.", actions: [{ command: ["AUTHORITY_REQUIRED", "HUMAN_ACTION_REQUIRED"].includes(code) ? "fleur setup" : "fleur doctor", description: "Inspect the exact prerequisite action before development startup." }] } : null, truncated: false };
}
const snapshot = (project: AdmittedProject) => digest(JSON.stringify([[...project.sources], [...project.resolutions], ...[...project.assets].map(([path, value]) => [path, value.url, digest(value.body)])]));
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), Math.max(1, milliseconds)); })]); }
  finally { clearTimeout(timer); }
}

/** The sole owner of a binding. CLI processes never acquire database/container handles. */
export async function supervise(project: string, host: string, requestedPort: number | undefined, timeoutMs: number, foreground = false, ownershipFd?: number, deadlineNs?: bigint): Promise<void> {
  const bound = await binding(project), ownership = ownershipFd === undefined ? await lock(bound.directory) : adoptLock(bound.directory, ownershipFd);
  if (!ownership) return;
  const nativeRoot = join(bound.directory, "native");
  await privateDirectory(nativeRoot);
  process.env.TMPDIR = nativeRoot;
  const previous = await readState(bound);
  if (previous && previous.state !== "stopped") { await ownership.close(); return; }
  const start = await startIdentity(process.pid);
  if (!start) { await ownership.close(); throw new Error("PREREQUISITE_UNAVAILABLE"); }
  const creation = new AbortController();
  let closed = false, generation: Generation | undefined, database: DevelopmentPostgres | undefined;
  let gateway: ReturnType<typeof Bun.serve> | undefined, watching: ReturnType<typeof setInterval> | undefined;
  const assets = new DevelopmentAssets();
  let active = 0, replacing = false, fingerprint = "", attempted = "", epoch = "";
  let pending: Promise<void> | undefined, stopping: Promise<ReturnType<typeof publicState>> | undefined;
  let writes = Promise.resolve();
  const state: State = { formatVersion: 1, binding: bound.id, instance: crypto.randomUUID(), pid: process.pid, start, token: randomBytes(32).toString("hex"), control: 1, state: "starting", url: null, generation: 0, error: null, initialization: null, initializationSummary: "", prerequisites: null, logs: previous?.logs ?? [], logSequence: previous?.logSequence ?? 0 };
  const persist = () => { const value = structuredClone(state); writes = writes.then(() => save(bound.directory, "instance.json", value)); return writes; };
  const log = async (code: string, message: string) => {
    state.logs.push({ sequence: ++state.logSequence, code, message: message.slice(0, 512) }); state.logs = state.logs.slice(-1000); await persist();
  };
  let config: { stateRoot: string; timeoutMs: number; controlUrl?: string } = { stateRoot: join(bound.directory, "maintenance"), timeoutMs: 5000 };
  const startupDeadline = performance.now() + (deadlineNs === undefined ? timeoutMs : Math.max(0, Number(deadlineNs - monotonicNanoseconds()) / 1000000));
  const checkOpen = () => { if (closed || state.state === "failed") throw new Error("RECOVERY_REQUIRED"); if (state.state === "starting" && performance.now() >= startupDeadline) throw new Error("READINESS_TIMEOUT"); };
  const retiring = new WeakMap<Generation, Promise<void>>(), runtimes = new WeakMap<Generation, Promise<void>>();
  const retireRuntime = (item: Generation): Promise<void> => {
    const existing = runtimes.get(item); if (existing) return existing;
    item.cancellation.abort();
    const closing = (async () => {
      const results = await Promise.allSettled([item.server.stop(true), item.app.close()]);
      if (results.some(result => result.status === "rejected")) throw new Error("EXECUTION_RECOVERY_REQUIRED");
    })();
    runtimes.set(item, closing);
    void closing.catch(() => { if (runtimes.get(item) === closing) runtimes.delete(item); });
    return closing;
  };
  const dispose = (item: Generation): Promise<void> => {
    const existing = retiring.get(item); if (existing) return existing;
    const closing = retireRuntime(item).then(() => item.images.dispose());
    retiring.set(item, closing);
    void closing.catch(() => { if (retiring.get(item) === closing) retiring.delete(item); });
    return closing;
  };
  // Roll back a superseded publication using the retained immutable images,
  // never by replaying initialization, migrations, seeds or submitted mutations.
  const restore = async (item: Generation) => {
    checkOpen();
    const cancellation = new AbortController();
    let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
    try {
      app = await ReadApplication.open(item.images, await database!.url(), config, {}, AbortSignal.any([creation.signal, cancellation.signal]));
      checkOpen(); server = serveReadApplication(app, item.browser);
      await verifyDevelopmentReadiness(app, item.browser, server.url, AbortSignal.timeout(30000));
      checkOpen();
      item.app = app; item.server = server; item.cancellation = cancellation;
      runtimes.delete(item); retiring.delete(item);
      state.state = "ready"; state.error = null;
    } catch (error) {
      cancellation.abort();
      await Promise.allSettled([server?.stop(true), app?.close()]);
      state.state = "failed"; state.error = "RECOVERY_REQUIRED"; await persist();
      throw error;
    }
  };
  let finishing: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    closed = true; creation.abort(); clearInterval(watching); replacing = true;
    const deadline = performance.now() + 30000;
    state.state = "maintenance"; state.error = null; await persist();
    const finish = finishing ??= (async () => {
      await pending?.catch(() => {});
      while (active && performance.now() < deadline) await Bun.sleep(10);
      if (active) throw new Error("RECOVERY_REQUIRED");
      await gateway?.stop(true);
      const { recoverExecution } = await import("./recovery");
      if (generation) {
        await dispose(generation);
        generation = undefined;
      }
      await recoverExecution(bound);
      database ??= await DevelopmentPostgres.read(bound) ?? undefined;
      await database?.stop(Math.max(1, deadline - performance.now()));
    })();
    void finish.finally(() => { if (finishing === finish) finishing = undefined; }).catch(() => {});
    try {
      await bounded(finish, deadline - performance.now());
      state.state = "stopped"; state.error = null; await log("STOPPED", "Owned development resources stopped; data and backups retained.");
      await ownership.close();
      setTimeout(() => { void controller.stop(true); }, 50);
    } catch (error) {
      const busy = error instanceof Error && error.message === "MAINTENANCE_BUSY";
      state.state = busy ? "maintenance" : "failed"; state.error = busy ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED";
      await log(state.error, "Shutdown could not verify retirement within its bound. Ownership evidence is retained; inspect status and logs before explicit stop.");
      stopping = undefined;
    }
    return publicState(state);
  })();
  if (foreground) { process.stdin.on("end", () => { void stop(); }); process.stdin.resume(); }
  const controller = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 40, async fetch(request) {
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${state.token}` || request.headers.get("x-fleur-instance") !== state.instance) return new Response(null, { status: 403 });
    const path = new URL(request.url).pathname;
    if (path === "/stop") return Response.json(await stop());
    if (path !== "/status") return new Response(null, { status: 404 });
    let health: Awaited<ReturnType<typeof databaseHealth>> | null = null;
    if (database && state.state !== "starting" && !closed) {
      try {
        const requested = Number(request.headers.get("x-fleur-timeout-ms"));
        const timeoutMs = Number.isFinite(requested) && requested > 0 && requested <= 2147483647 ? requested : 5000;
        health = await databaseHealth(await database.url(), { kind: "development", database: "application" }, bound.project, { ...config, timeoutMs });
        if (closed) return Response.json({ ...publicState(state), database: health.database, reasons: health.reasons.map(code => ({ code, ...readinessReasons[code] })) });
        if (state.state !== "failed" && health.reasons.length) {
          state.state = health.reasons.some(code => ["DATABASE_UNAVAILABLE", "PREREQUISITE_UNAVAILABLE"].includes(code)) ? "failed" : "maintenance";
          if (state.state === "failed") creation.abort();
          const code = health.reasons[0]!;
          if (state.error !== code) { state.error = code; await log(code, readinessReasons[code].message); }
        } else if (state.state === "maintenance" && state.error === "MAINTENANCE_ACTIVE") { state.state = "ready"; state.error = null; await persist(); }
      } catch (error) {
        if (!closed && state.state !== "failed") { state.state = "failed"; creation.abort(); state.error = safeCode(error); await log(state.error, "Development health failed. Inspect logs and explicitly stop before restarting."); }
      }
    }
    const reasons: { code: string; message?: string; action: { command: string; description: string } }[] = health?.reasons.map(code => ({ code, ...readinessReasons[code] })) ?? [];
    if (state.state !== "ready" && state.state !== "stopped" && state.error && !reasons.some(reason => reason.code === state.error)) reasons.push({ code: state.error, action: { command: state.error === "PREREQUISITE_UNAVAILABLE" ? "fleur doctor" : "fleur logs", description: "Inspect the reported cause before explicit recovery or restart." } });
    return Response.json({ ...publicState(state), database: health?.database ?? null, execution: generation?.app.executionStatus() ?? null, reasons });
  } });
  state.control = controller.port!;
  await log("STARTING", "Starting the owned development environment.");

  async function candidate(source: AdmittedProject, startup: boolean): Promise<Generation> {
    const cancellation = new AbortController(), signal = AbortSignal.any([creation.signal, cancellation.signal]);
    let images: Images | undefined, app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined, client: BrowserBuild | undefined;
    try {
      checkOpen();
      client = await compileClient(source); checkOpen();
      await log("CLIENT_COMPILED", "Admitted browser assets compiled.");
      const compiled = await compileWorker(source); checkOpen();
      images = await prepareDevelopmentImages(compiled, bound, checkOpen); checkOpen();
      await log("IMAGES_READY", "Restricted execution images prepared.");
      const url = await database!.url();
      if (startup) {
        const worker = await startWorker(images), session = crypto.randomUUID();
        let registry;
        try {
          const result = await worker.run({ mode: "register", session }, () => { throw new Error("REQUEST_DENIED"); });
          if (!result || typeof result !== "object" || !("value" in result)) throw new Error("SOURCE_REJECTED");
          registry = restoreManifest(result.value);
        } finally { await worker.close(); }
        checkOpen();
        const report = await startDevelopmentDatabase({ url, binding: bound.id }, bound.project, registry.seeds, { ...config, timeoutMs: Math.max(1, startupDeadline - performance.now()) });
        state.initialization = report.initialization;
        state.initializationSummary = describeDevelopmentStartup(report).slice(0, 8192);
        if (!report.ready) throw new Error(report.error?.code ?? report.reasons[0]?.code ?? "DATABASE_UNAVAILABLE");
      }
      checkOpen(); app = await ReadApplication.open(images, url, config, {}, signal); checkOpen();
      server = serveReadApplication(app, client);
      await verifyDevelopmentReadiness(app, client, server.url, AbortSignal.timeout(Math.max(1, Math.ceil(startup ? startupDeadline - performance.now() : 60000))));
      checkOpen();
      return { cancellation, images, app, server, browser: client };
    } catch (error) {
      cancellation.abort();
      if (app && server && images && client) await dispose({ cancellation, app, server, images, browser: client });
      else { await app?.close(); await images?.dispose(); }
      throw error;
    }
  }
  async function publish(next: Generation, stamp: string) {
    checkOpen();
    // Hold the shared maintenance fence through retirement and publication.
    const lease = await MaintenanceLease.acquire(await database!.url(), false, { ...config, tables: next.app.registry.tables, completeRegistry: true });
    const old = generation;
    try {
      checkOpen();
      if (snapshot(await admitProject(bound.project)) !== stamp) throw new Error("SOURCE_OBSOLETE");
      const retainAssets = assets.prepare(next.browser);
      replacing = true;
      const deadline = performance.now() + 30000;
      if (old) {
        state.state = "maintenance"; state.error = null;
        old.cancellation.abort();
        await log("DRAINING", "Closing public admission and draining the previous generation.");
      }
      while (active && performance.now() < deadline) await Bun.sleep(10);
      if (active) { state.state = "failed"; state.error = "RECOVERY_REQUIRED"; await persist(); throw new Error("RECOVERY_REQUIRED"); }
      if (old) {
        try { await bounded(retireRuntime(old), deadline - performance.now()); }
        catch { state.state = "failed"; state.error = "RECOVERY_REQUIRED"; await persist(); throw new Error("RECOVERY_REQUIRED"); }
      }
      try {
        const nextEpoch = await lease.epoch();
        checkOpen();
        // No asynchronous work separates this final snapshot check from the
        // pointer swap. A save during retirement instead restores the old app.
        if (snapshot(await admitProject(bound.project)) !== stamp) throw new Error("SOURCE_OBSOLETE");
        checkOpen();
        retainAssets();
        generation = next; fingerprint = stamp; epoch = nextEpoch; state.generation++;
        state.state = "ready"; state.error = null;
      } catch (error) { if (old && !closed) await restore(old); throw error; }
      await log("READY", "Database, source, rendering, browser assets and reactive transport verified.");
      if (old && old.browser.compatibility !== next.browser.compatibility) await log("CLIENT_NAVIGATION_REQUIRED", "An incompatible or uncertain client edit retains existing views and drafts. Navigate or reload explicitly to use the new generation.");
      await old?.images.dispose();
    } catch (error) {
      if (generation === next) {
        next.cancellation.abort(); state.state = "failed"; state.error = "RECOVERY_REQUIRED";
        await persist();
      }
      throw error;
    } finally { replacing = false; await lease.close(); }
  }
  pending = (async () => {
    checkOpen();
    const deadline = startupDeadline;
    let endpoint: string | undefined;
    const prerequisite = await doctor({ args: [], project: bound.project, timeoutSeconds: Math.max(0.001, (deadline - performance.now()) / 1000), json: true }, productionHost(), value => { endpoint = value; });
    state.prerequisites = prerequisiteSummary(prerequisite);
    if (!prerequisite.result.ok) {
      const code = prerequisite.result.error?.code ?? "PREREQUISITE_UNAVAILABLE";
      await log(code, "The prerequisite gate did not admit this runtime. Inspect fleur doctor and any required setup action.");
      throw new Error(code);
    }
    if (!endpoint) throw new Error("PREREQUISITE_UNAVAILABLE");
    // Bind all subsequent control to the exact local endpoint Doctor qualified.
    process.env.DOCKER_HOST = endpoint; delete process.env.DOCKER_CONTEXT;
    checkOpen();
    const handle = async (request: Request): Promise<Response> => {
      const incoming = new URL(request.url), address = incoming.hostname.replace(/^\[|\]$/g, "");
      const reported = state.url ? new URL(state.url) : null;
      const broad = host === "0.0.0.0" || host === "::";
      const localAddress = address === "localhost" || Object.values(networkInterfaces()).flat().some(value => value?.address === address);
      if (!reported || incoming.port !== reported.port || !(incoming.hostname === reported.hostname || address === host || broad && localAddress)) return new Response(null, { status: 403 });
      const expected = incoming.origin;
      const asset = generation?.browser.files.get(incoming.pathname) ?? assets.get(incoming.pathname);
      if (!closed && asset && ["GET", "HEAD"].includes(request.method)) return new Response(request.method === "HEAD" ? null : typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer, { headers: { "Content-Type": asset.type, "X-Content-Type-Options": "nosniff", "Cache-Control": asset.cache ?? "public, max-age=31536000, immutable" } });
      if (closed || replacing || !generation || state.state === "failed") {
        const code = closed ? "REQUEST_DENIED" : "MAINTENANCE_BUSY";
        return incoming.pathname === "/__fleur/mutation" ? Response.json({ status: "failure", error: { code } }, { status: 503 }) : Response.json({ error: { code } }, { status: 503 });
      }
      active++;
      const target = generation, marker = `${state.instance}:${state.generation}`;
      try {
        const headers = new Headers(request.headers); headers.delete("host");
        const origin = headers.get("origin");
        if (origin && origin !== expected) return new Response(null, { status: 403 });
        const stale = refuseStaleBrowser(request, { marker, browser: target.browser });
        if (stale) return stale;
        if (origin) headers.set("origin", target.server.url.origin);
        const response = await fetch(new URL(incoming.pathname + incoming.search, target.server.url), { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, signal: AbortSignal.timeout(30000) });
        const output = new Headers(response.headers);
        const csp = output.get("content-security-policy");
        if (csp) {
          let policy = csp.replaceAll(target.server.url.origin, expected);
          // The stable development document must admit a later compiler-owned
          // stylesheet. Application stylesheet injection remains prohibited.
          if (target.browser.stylesheet) policy = policy.replace(new URL(target.browser.stylesheet, expected).href, new URL("/assets/", expected).href);
          output.set("content-security-policy", policy);
        }
        for (const [name, value] of Object.entries(browserVersionHeaders({ marker, browser: target.browser }))) output.set(name, value);
        const result = new Response(await response.arrayBuffer(), { status: response.status, headers: output });
        return output.get("content-type")?.startsWith("text/html") ? new HTMLRewriter().on("head", { element(element) { element.append(`<meta name="fleur-development" content="${marker}"><meta name="fleur-client-compatibility" content="${target.browser.compatibility ?? ""}">`, { html: true }); } }).transform(result) : result;
      } catch {
        if (!closed && generation === target) {
          state.state = "failed"; closed = true; creation.abort(); state.error = "INSTANCE_UNAVAILABLE";
          await log("INSTANCE_UNAVAILABLE", "Application transport failed. Inspect retained logs and explicitly stop before restarting.");
        }
        return incoming.pathname === "/__fleur/mutation" ? Response.json({ status: "outcome-unknown" }, { status: 503 }) : Response.json({ error: { code: "INSTANCE_UNAVAILABLE" } }, { status: 503 }); }
      finally { active--; }
    };
    let port = requestedPort ?? 3000;
    for (;;) {
      try { gateway = Bun.serve({ hostname: host, port, idleTimeout: 30, fetch: handle }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw new Error("PREREQUISITE_UNAVAILABLE");
        if (requestedPort !== undefined || port === 65535) throw new Error("PORT_OCCUPIED");
        port++;
      }
    }
    state.url = gateway.url.href; await persist();
    database = await DevelopmentPostgres.start(bound, deadline, checkOpen); checkOpen();
    config = { ...config, controlUrl: await database.url("postgres") };
    await log("DATABASE_CONNECTED", "Owned development PostgreSQL is connected.");
    const source = await admitProject(bound.project), stamp = snapshot(source);
    const next = await candidate(source, true);
    if (closed || performance.now() >= deadline) { await dispose(next); throw new Error("READINESS_TIMEOUT"); }
    try { await publish(next, stamp); }
    catch (error) { await dispose(next); throw error; }
    watching = setInterval(() => {
      if (closed || pending || state.state === "failed") return;
      pending = (async () => {
        let next: Generation | undefined;
        try {
          const source = await admitProject(bound.project), stamp = snapshot(source);
          if (stamp === fingerprint && state.error === null) return;
          if (stamp === attempted && state.state === "maintenance") {
            const admission = await MaintenanceLease.acquire(await database!.url(), false, config, true);
            try {
              if (admission.busy) return;
              const changed = await admission.epoch();
              if (changed !== epoch) { epoch = changed; attempted = ""; }
            } finally { await admission.close(); }
          }
          if (stamp === attempted) return;
          attempted = stamp;
          next = await candidate(source, false);
          if (closed) { await dispose(next); return; }
          await publish(next, stamp); next = undefined;
        } catch (error) {
          let cleanup = false;
          if (next && generation !== next) { try { await dispose(next); } catch { cleanup = true; } }
          const published = next !== undefined && generation === next;
          const code = cleanup || published ? "RECOVERY_REQUIRED" : state.state === "failed" && state.error ? state.error : safeCode(error);
          if (cleanup || published) state.state = "failed";
          state.error = code;
          if (code === "SCHEMA_DRIFT" || code === "MIGRATIONS_PENDING") {
            generation?.app.blockDatabase(code); state.state = "maintenance";
          }
          // SQL maintenance fences still independently protect every broker transaction.
          await log(code, state.state === "failed" ? "Reload cannot resume a failed application or verify retirement. Admission remains closed; retain ownership evidence and explicitly stop before restarting." : error instanceof SourceAdmissionError ? `${error.diagnostic.file}:${error.diagnostic.line} ${error.diagnostic.code}. ${error.diagnostic.action}` : code === "BROWSER_ASSET_CAPACITY" ? "The bounded development browser-asset cache is full. Explicitly stop and dev to clear disposable assets; development data and backups are preserved." : "Reload refused. Correct the source or inspect database maintenance, then save the corrected files. The last valid generation is retained.");
        }
      })().finally(() => { pending = undefined; });
    }, 300);
  })();
  const startup = pending;
  const timer = setTimeout(() => { if (state.state === "starting") { closed = true; creation.abort(); state.state = "failed"; state.error = "READINESS_TIMEOUT"; void log("READINESS_TIMEOUT", "Startup exceeded its readiness deadline. Inspect status and logs, then explicitly stop before restarting."); } }, Math.max(1, startupDeadline - performance.now()));
  void startup.catch(async error => { if (!closed) { state.state = "failed"; creation.abort(); state.error = safeCode(error); await log(state.error, "Development startup failed. Inspect status and logs; explicitly stop before restarting."); } }).finally(() => { clearTimeout(timer); pending = undefined; });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void stop(); });
}
