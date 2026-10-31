import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import release from "../../../package.json" with { type: "json" };
import { doctor } from "../../setup/doctor";
import { productionHost } from "../../setup/host";
import { ReadApplication } from "../application";
import type { BrowserBuild } from "../build/client";
import { databaseHealth } from "../database/health";
import { digest, privateDirectory, type MaintenanceConfiguration } from "../database/maintenance";
import { privilegeShortfall } from "../database/privilege";
import { selectTarget } from "../database/target";
import { forwardDevelopmentRequest } from "../development/forwarding";
import { verifyDevelopmentReadiness } from "../development/readiness";
import { recoverExecution } from "../development/recovery";
import { lock, monotonicNanoseconds, save, startIdentity, type Binding } from "../development/state";
import { serveReadApplication } from "../http";
import { productionDirectory, verifyArtifact } from "./artifact";
import type { ProductionRegistration } from "./registration";
import { importArtifactImages } from "./images";
import { startFailures, type SupervisorEvent } from "./protocol";

const clientIndex = z.strictObject({
  entry: z.string(), module: z.string().optional(), compatibility: z.string().optional(), stylesheet: z.string().optional(),
  files: z.array(z.strictObject({ path: z.string(), file: z.string().regex(/^client\/files\/[0-9]{5}$/), type: z.string(), cache: z.literal("no-cache").optional() })),
});
const publish = (event: SupervisorEvent) => { process.stdout.write(JSON.stringify(event) + "\n"); };
/** Fixed diagnostic codes only: application data and configuration never reach logs. */
const log = (code: string) => { process.stderr.write(`${new Date().toISOString()} ${code}\n`); };
async function loadBrowser(root: string): Promise<BrowserBuild> {
  const index = clientIndex.parse(JSON.parse(await Bun.file(join(root, "client/index.json")).text()));
  const files = new Map<string, { body: string | Uint8Array; type: string; cache?: "no-cache" }>();
  for (const entry of index.files) files.set(entry.path, { body: new Uint8Array(await Bun.file(join(root, entry.file)).arrayBuffer()), type: entry.type, ...entry.cache ? { cache: entry.cache } : {} });
  return { entry: index.entry, ...index.module ? { module: index.module } : {}, ...index.compatibility ? { compatibility: index.compatibility } : {}, ...index.stylesheet ? { stylesheet: index.stylesheet } : {}, files };
}
const reasonCodes: Readonly<Record<string, string>> = { DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE", MIGRATION_PENDING: "MIGRATIONS_PENDING", SCHEMA_DRIFT: "SCHEMA_DRIFT", MAINTENANCE_ACTIVE: "MAINTENANCE_BUSY", RECOVERY_REQUIRED: "RECOVERY_REQUIRED", PREREQUISITE_UNAVAILABLE: "PREREQUISITE_UNAVAILABLE" };
function failureCode(error: unknown): string {
  if (privilegeShortfall(error)) return "DATABASE_PRIVILEGE_INSUFFICIENT";
  if (error instanceof Error && error.message in startFailures) return error.message;
  // Internal codes are fixed identifiers. Anything else may quote configuration.
  if (error instanceof Error && /^[A-Z][A-Z_]{1,63}$/.test(error.message)) log(error.message);
  return "INTERNAL_FAILURE";
}

/** The sole owner of one production start: execution containers, never the database. */
export async function superviseProduction(artifact: string, host: string, port: number, deadlineNs: bigint): Promise<void> {
  const remaining = () => Math.max(1, Number(deadlineNs - monotonicNanoseconds()) / 1e6);
  const creation = new AbortController();
  let app: ReadApplication | undefined, internal: ReturnType<typeof serveReadApplication> | undefined;
  let gateway: ReturnType<typeof Bun.serve> | undefined, ownership: { close(): Promise<void> } | undefined;
  let bound: Binding | undefined, ready = false, closed = false, active = 0, stopping: Promise<void> | undefined;
  const registration: { -readonly [Key in keyof ProductionRegistration]: ProductionRegistration[Key] } = { formatVersion: 1, artifact: "", pid: process.pid, start: "", url: "", state: "starting", fingerprint: null };
  const persist = async () => { if (bound) await save(bound.directory, "instance.json", registration); };
  let startup: Promise<void> = Promise.resolve();
  const stop = (exit: () => void) => stopping ??= (async () => {
    closed = true; ready = false; creation.abort();
    // Startup may still be creating containers. Close only what it finished creating.
    await Promise.race([startup.catch(() => {}), Bun.sleep(30000)]);
    const drain = performance.now() + 30000;
    while (active && performance.now() < drain) await Bun.sleep(10);
    const leftover = active > 0;
    await gateway?.stop(true);
    await Promise.allSettled([internal?.stop(true)]);
    await app?.close();
    if (bound) await recoverExecution(bound);
    registration.state = "stopped"; await persist();
    await ownership?.close();
    if (leftover) throw new Error("EXECUTION_RECOVERY_REQUIRED");
    exit();
  })();
  const fail = async (code: string) => {
    log(code);
    let final = code;
    try { await stop(() => {}); } catch { final = "EXECUTION_RECOVERY_REQUIRED"; }
    publish({ event: "failed", code: final });
    process.exit(startFailures[final]?.exit ?? 1);
  };
  const shutdown = () => {
    void stop(() => { log("STOPPED"); publish({ event: "stopped" }); process.exit(0); }).catch(() => fail("EXECUTION_RECOVERY_REQUIRED"));
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, shutdown);
  // The launcher holds this pipe open: its death, however abrupt, stops this owner.
  process.stdin.on("end", shutdown); process.stdin.resume();
  const timer = setTimeout(() => { if (!ready) void fail("READINESS_TIMEOUT"); }, remaining());
  startup = (async () => {
    const { root, manifest } = await verifyArtifact(artifact, release.version);
    const target = selectTarget(true, process.env);
    const config: MaintenanceConfiguration = { ...process.env.FLEUR_PRIVATE_STATE_ROOT ? { stateRoot: process.env.FLEUR_PRIVATE_STATE_ROOT } : {}, ...process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL ? { controlUrl: process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL } : {} };
    // Held only by the trusted broker from here: no child process inherits them.
    for (const name of ["FLEUR_PRIVATE_DATABASE_URL", "FLEUR_PRIVATE_CONTROL_DATABASE_URL", "FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL"]) delete process.env[name];
    const directory = productionDirectory(homedir(), manifest.project);
    await privateDirectory(directory);
    ownership = (await lock(directory)) ?? undefined;
    if (!ownership) throw new Error("ALREADY_RUNNING");
    // Only the lock holder may write registration or resolve execution journals.
    bound = { project: root, id: digest(`fleur:production:binding:${manifest.project}`), directory };
    const start = await startIdentity(process.pid);
    if (!start) throw new Error("PREREQUISITE_UNAVAILABLE");
    registration.artifact = manifest.id; registration.start = start;
    await privateDirectory(join(directory, "native"));
    process.env.TMPDIR = join(directory, "native");

    const browser = await loadBrowser(root), registered = await Bun.file(join(root, "manifest/registry.json")).text();
    const handle = async (request: Request): Promise<Response> => {
      const incoming = new URL(request.url), address = incoming.hostname.replace(/^\[|\]$/g, "");
      const broad = host === "0.0.0.0" || host === "::";
      const local = address === "localhost" || Object.values(networkInterfaces()).flat().some(value => value?.address === address);
      if (Number(incoming.port || 80) !== gateway?.port || !(address === host || incoming.hostname === new URL(gateway.url).hostname || broad && local)) return new Response(null, { status: 403 });
      if (incoming.pathname === "/__fleur/health") {
        if (request.method !== "GET") return new Response(null, { status: 405 });
        let available = ready && !closed;
        if (available) { try { await Promise.race([app!.revision(), Bun.sleep(2000).then(() => { throw new Error("QUERY_TIMEOUT"); })]); } catch { available = false; } }
        return Response.json({ status: available ? "available" : "unavailable" }, { status: available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
      }
      if (!ready || closed || !internal) return incoming.pathname === "/__fleur/mutation" ? Response.json({ status: "failure", error: { code: "MAINTENANCE_BUSY" } }, { status: 503 }) : Response.json({ error: { code: "MAINTENANCE_BUSY" } }, { status: 503 });
      active++;
      try {
        return await forwardDevelopmentRequest(request, incoming.origin, { url: internal.url, healthURL: internal.healthURL, browser }, async () => { void fail("INSTANCE_UNAVAILABLE"); });
      } finally { active--; }
    };
    try { gateway = Bun.serve({ hostname: host, port, idleTimeout: 30, fetch: handle }); }
    catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "PORT_OCCUPIED" : "PREREQUISITE_UNAVAILABLE"); }
    registration.url = gateway.url.href; await persist();

    let images: Awaited<ReturnType<typeof importArtifactImages>> | undefined;
    const prerequisite = await doctor({ args: [], project: root, timeoutSeconds: remaining() / 1000, json: true }, productionHost(), value => { process.env.DOCKER_HOST = value; delete process.env.DOCKER_CONTEXT; }, undefined, async endpoint => {
      images = await importArtifactImages(root, manifest, endpoint, remaining());
      return images.worker;
    });
    if (!prerequisite.result.ok) throw new Error(prerequisite.result.error?.code ?? "PREREQUISITE_UNAVAILABLE");
    if (!images) throw new Error("PREREQUISITE_UNAVAILABLE");
    log("IMAGES_READY");
    // An earlier owner that died uncleanly left journals only this owner may resolve.
    await recoverExecution(bound);

    const health = await databaseHealth(target.url, { kind: "production", database: target.database }, join(root, "schema"), { ...config, timeoutMs: Math.min(remaining(), 5000) });
    if (health.reasons.length) throw new Error(reasonCodes[health.reasons[0]!] ?? "PREREQUISITE_UNAVAILABLE");
    registration.fingerprint = health.database.target.fingerprint;
    log("DATABASE_COMPATIBLE");
    app = await ReadApplication.open(images, target.url, config, {}, creation.signal);
    if (app.registry.encoded !== registered) throw new Error("SOURCE_REJECTED");
    internal = serveReadApplication(app, browser);
    await verifyDevelopmentReadiness(app, browser, internal.url, AbortSignal.timeout(Math.ceil(remaining())));
    clearTimeout(timer);
    if (closed) return;
    ready = true; registration.state = "ready"; await persist();
    log("READY");
    publish({ event: "ready", url: gateway.url.href, artifact: manifest.id });
  })();
  await startup.catch(async error => { clearTimeout(timer); if (!closed) await fail(failureCode(error)); });
}
