import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { CommandInput } from "../../cli/catalog";
import { failure, success, type CliOutcome, type Json } from "../../cli/result";
import { binding, lock, monotonicNanoseconds, ownershipHeld, readState, save, startIdentity, type Binding, type State } from "./state";
import { control, logs, publicState } from "./protocol";
import { DevelopmentPostgres } from "./postgres";

const value = (args: readonly string[], name: string) => args.includes(name) ? args[args.indexOf(name)+1] : undefined;
function failed(command: string, code: string, diagnostic: Json = null): CliOutcome {
  const outcome = failure(command, code === "ARGUMENT_INVALID" ? 2 : ["AUTHORITY_REQUIRED", "HUMAN_ACTION_REQUIRED"].includes(code) ? 3 : ["RECOVERY_REQUIRED", "EXECUTION_RECOVERY_REQUIRED", "IMAGE_RECOVERY_REQUIRED", "MAINTENANCE_BUSY", "SCHEMA_DRIFT", "MIGRATIONS_PENDING", "MIGRATION_EDITED", "SEED_CONFLICT"].includes(code) ? 5 : ["SOURCE_REJECTED", "SOURCE_OBSOLETE", "INTERNAL_FAILURE", "INSTANCE_UNAVAILABLE", "SEED_INVALID", "MIGRATION_INCOMPATIBLE"].includes(code) ? 1 : 4, { code, message: "The development operation could not complete safely.", actions: [{ command: "fleur logs", description: "Inspect retained diagnostics. Correct the cause, then explicitly stop before restarting a failed instance." }] }, diagnostic);
  return diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic) && "initializationSummary" in diagnostic && typeof diagnostic.initializationSummary === "string" ? { ...outcome, human: `${code}: Development did not become ready.\n${diagnostic.initializationSummary}Next: fleur logs.\n` } : outcome;
}
async function inspect(bound: Binding, state: State, timeoutMs: number) {
  if (state.state === "stopped") return { ...publicState(state), database: null };
  try { return await control(bound, state, "status", timeoutMs); }
  catch { return { ...publicState(state), state: "failed", ready: false, error: "INSTANCE_UNAVAILABLE" }; }
}
/** Read-only lifecycle discovery; no database or supervisor is started by observation. */
export async function developmentStatus(project: string, timeoutMs = 5000): Promise<Json | null> {
  let bound: Binding;
  try { bound = await binding(project, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return { state: "failed", ready: false, error: "RECOVERY_REQUIRED", database: null }; }
  try {
    const state = await readState(bound);
    if (state && !(state.state === "stopped" && await ownershipHeld(bound))) return JSON.parse(JSON.stringify(await inspect(bound, state, timeoutMs))) as Json;
    const evidence = await readdir(bound.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    return await ownershipHeld(bound) || evidence.some(name => name !== "owner.lock") ? { state: "failed", ready: false, error: "RECOVERY_REQUIRED", database: null, reasons: [{ code: "RECOVERY_REQUIRED", action: { command: "fleur logs", description: "Publication evidence is missing or stale while ownership or resource evidence remains. Retain records and inspect logs before explicit recovery." } }] } : null;
  } catch { return { state: "failed", ready: false, error: "RECOVERY_REQUIRED", database: null, reasons: [{ code: "RECOVERY_REQUIRED", action: { command: "fleur logs", description: "Inspect retained lifecycle ownership evidence before recovery." } }] }; }
}
type Emit = (event: string, data: unknown) => void;
export async function runLifecycle(command: string, input: CommandInput): Promise<CliOutcome> {
  const streaming = command === "dev" && !input.args.includes("--background") || command === "logs" && input.args.includes("--follow");
  let sequence = 0;
  const emit: Emit = (event, data) => {
    if (input.json) process.stdout.write(JSON.stringify({ formatVersion: 1, command, sequence: sequence++, event, data })+"\n");
    else if (event === "ready" && data && typeof data === "object" && "initializationSummary" in data && typeof data.initializationSummary === "string") process.stdout.write(`Development ready.\n${data.initializationSummary}`);
    else process.stdout.write(`${event}: ${JSON.stringify(data)}\n`);
  };
  if (streaming && command === "dev") emit("starting", { state: "starting", ready: false });
  if (command === "dev" && !["127.0.0.1", "localhost", "::1"].includes(value(input.args, "--host") ?? "127.0.0.1")) process.stderr.write("Warning: v1 has no authentication; this application bind exposes it beyond loopback.\n");
  const outcome = await executeLifecycle(command, input, emit);
  if (!streaming) return outcome;
  emit("completed", { result: outcome.result, exitCode: outcome.exitCode });
  return { ...outcome, streamed: true };
}
async function executeLifecycle(command: string, input: CommandInput, emit: Emit): Promise<CliOutcome> {
  try {
    const bound = await binding(input.project), timeoutMs = input.timeoutSeconds * 1000;
    if (command === "stop") {
      const deadline = performance.now() + Math.min(timeoutMs, 30000);
      for (;;) {
        const ownership = await lock(bound.directory);
        if (ownership) {
          try {
            const previous = await readState(bound);
            if (previous && previous.state !== "stopped") {
              if (await startIdentity(previous.pid) === previous.start) {
                const result = await control(bound, previous, "stop", Math.max(1, deadline - performance.now()));
                return "state" in result && result.state === "stopped" ? success(command, JSON.parse(JSON.stringify(result)) as Json) : failed(command, "RECOVERY_REQUIRED");
              }
            }
            // A lost publication record never proves resources were absent.
            // Reconcile private ownership journals even when state is missing
            // or says stopped; unverified evidence must survive a failed stop.
            const { recoverExecution } = await import("./recovery");
            await recoverExecution(bound);
            await (await DevelopmentPostgres.read(bound))?.stop(Math.max(1, deadline - performance.now()));
            if (previous || (await readdir(bound.directory)).some(name => name !== "owner.lock")) {
              // A durable stopped receipt allows explicit restart after missing
              // publication evidence has been reconciled. It grants no live owner.
              const start = previous?.start ?? await startIdentity(process.pid);
              if (!start) throw new Error("RECOVERY_REQUIRED");
              const receipt: State = previous ?? { formatVersion: 1, binding: bound.id, instance: crypto.randomUUID(), pid: process.pid, start, token: randomBytes(32).toString("hex"), control: 1, state: "stopped", url: null, generation: 0, error: null, initialization: null, initializationSummary: "", prerequisites: null, logs: [], logSequence: 0 };
              receipt.state = "stopped"; receipt.error = null;
              await save(bound.directory, "instance.json", receipt);
            }
            return success(command, { state: "stopped", ready: false });
          } finally { await ownership.close(); }
        }
        const state = await readState(bound);
        if (state && state.state !== "stopped") {
          const result = await control(bound, state, "stop", Math.max(1, deadline - performance.now()));
          return "state" in result && result.state === "stopped" ? success(command, JSON.parse(JSON.stringify(result)) as Json) : failed(command, "error" in result && result.error === "MAINTENANCE_BUSY" ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED");
        }
        if (performance.now() >= deadline) return failed(command, "MAINTENANCE_BUSY");
        await Bun.sleep(10);
      }
    }
    if (command === "logs") {
      const state = await readState(bound);
      if (!state) return success(command, { logs: [], cursor: null });
      const page = logs(state, Number(value(input.args, "--limit") ?? 200), value(input.args, "--cursor"));
      if (!input.args.includes("--follow")) { const outcome = success(command, page); return { ...outcome, result: { ...outcome.result, truncated: page.truncated } }; }
      return follow(command, input, bound, state, emit, page.cursor, page);
    }
    const deadline = performance.now() + timeoutMs;
    let state = await readState(bound);
    let launched: import("bun").Subprocess<"pipe", "ignore", "ignore"> | undefined;
    if (!state || state.state === "stopped") {
      // Detach the owner even in foreground mode. Only its creating launcher receives shutdown authority.
      const ownership = await lock(bound.directory);
      if (ownership) {
        try {
          state = await readState(bound);
          if (!state && (await readdir(bound.directory)).some(name => name !== "owner.lock")) return failed(command, "RECOVERY_REQUIRED");
          if (!state || state.state === "stopped") {
            // The child inherits this exact locked file description: there is no
            // unlocked gap before supervisor publication, even if its launcher dies.
            launched = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("entry.ts", import.meta.url)), bound.project, value(input.args, "--host") ?? "127.0.0.1", value(input.args, "--port") ?? "auto", String(monotonicNanoseconds() + BigInt(Math.max(1, Math.ceil((deadline - performance.now()) * 1000000)))), input.args.includes("--background") ? "background" : "foreground", "owned-fd-3"], { env: { ...process.env }, stdio: ["pipe", "ignore", "ignore", ownership.fd], detached: true });
            launched.unref();
            if (input.args.includes("--background")) launched.stdin.end();
          }
        } finally { await ownership.close(); }
      }
    }
    for (;;) {
      state = await readState(bound);
      if (state && state.state !== "stopped") {
        const observed = await inspect(bound, state, Math.min(5000, Math.max(1, deadline-performance.now())));
        if ("state" in observed && observed.state !== "starting" && !(state.state === "starting" && observed.state === "failed")) {
          if (observed.state !== "ready") return failed(command, state.error ?? "INSTANCE_UNAVAILABLE", JSON.parse(JSON.stringify(observed)) as Json);
          const summary = "initializationSummary" in observed && typeof observed.initializationSummary === "string" ? observed.initializationSummary : "";
          const outcome = { ...success(command, JSON.parse(JSON.stringify(observed)) as Json), human: `Development ready${"url" in observed ? ` at ${String(observed.url)}` : ""}.\n${summary}` };
          if (input.args.includes("--background") || !launched || launched.pid !== state.pid) { launched?.stdin.end(); return outcome; }
          try { return await follow(command, input, bound, state, emit); } finally { launched.stdin.end(); }
        }
      }
      if (performance.now() >= deadline) return failed(command, "READINESS_TIMEOUT");
      if (launched?.exitCode !== null && launched?.exitCode !== undefined) {
        return failed(command, "PREREQUISITE_UNAVAILABLE");
      }
      await Bun.sleep(50);
    }
  } catch (error) { return failed(command, error instanceof Error && error.message === "ARGUMENT_INVALID" ? "ARGUMENT_INVALID" : "RECOVERY_REQUIRED"); }
}
async function follow(command: string, input: CommandInput, bound: Binding, owner: State, emit: Emit, cursor?: string, first?: ReturnType<typeof logs>): Promise<CliOutcome> {
  let ended = false, stopped = false;
  const end = () => { ended = true; };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, end);
  emit(command === "dev" ? "ready" : "log-result", first ?? publicState(owner));
  let last = "";
  try {
    while (!ended) {
      const state = await readState(bound);
      if (!state || state.instance !== owner.instance) { ended = true; break; }
      if (command === "logs") {
        const page = logs(state, Number(value(input.args, "--limit") ?? 200), cursor);
        if (page.logs.length) emit("log-result", page);
        cursor = page.cursor;
      }
      const observed = await inspect(bound, state, 5000), serialized = JSON.stringify(observed);
      if (serialized !== last) { emit("state", observed); last = serialized; }
      if ("state" in observed && ["stopped", "failed"].includes(String(observed.state))) { stopped = observed.state === "stopped"; break; }
      await Bun.sleep(200);
    }
    if (command === "dev" && ended) {
      const current = await readState(bound);
      if (current?.instance === owner.instance) {
        const result = await control(bound, owner, "stop", 31000);
        stopped = "state" in result && result.state === "stopped";
      }
    }
    const outcome = command === "logs" || stopped ? success(command, { state: stopped ? "stopped" : "completed", ready: false }) : failed(command, "INSTANCE_UNAVAILABLE");
    return outcome;
  } finally { for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, end); }
}
