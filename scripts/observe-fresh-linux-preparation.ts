import { startRetainedSsh } from "./retained-ssh.ts";
import type { Readable } from "node:stream";
import type { BootTarget } from "./observe-fresh-linux-boot.ts";
interface Stage { stage: string; state: "started" | "completed"; hostElapsedMs: number; guestElapsedMs?: number }
export interface PreparationObservation {
  formatVersion: 1; scope: "fresh-linux-preparation-observation"; ok: boolean;
  transport: { timeoutMs: number; elapsedMs: number; deadlineFired: boolean; exitCode: number | null; signal: string | null; stdoutBytes: number; stderrBytes: number; outputLimitExceeded: boolean };
  stages: Stage[]; lastStage: Stage | null; bun?: Record<string, unknown>;
  localCleanup?: { retired: boolean; elapsedMs: number; budgetMs: 3000; error?: { code: string; message: string } };
  evidenceError?: { code: string; message: string };
  error?: { code: string; message: string };
}
const bunStages = ["archive-authentication", "zip-entry-validation", "executable-extraction", "retained-output-authentication", "archive-reauthentication", "output-custody", "cleanup"];
const artifactStages = ["bun-preparation", "candidate-extraction", "restriction-extraction", "complete"];
const archiveSha256 = "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18";
const event = (stage: string, state: string) => `printf '${JSON.stringify({ formatVersion: 1, scope: "guest-artifact-preparation-event", stage, state })}\\n'`;
/** The original ten-second preparation boundary, with allowlisted partial evidence. */
export async function observePreparation(target: BootTarget, remainingBudgetMs = 10000): Promise<PreparationObservation> {
  const timeoutMs = Math.max(1, Math.min(10000, remainingBudgetMs)); const started = performance.now();
  const result: PreparationObservation = { formatVersion: 1, scope: "fresh-linux-preparation-observation", ok: false, transport: { timeoutMs, elapsedMs: 0, deadlineFired: false, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, outputLimitExceeded: false }, stages: [], lastStage: null };
  const fail = (code: string, message: string) => { result.error ??= { code, message }; };
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts || !Number.isFinite(remainingBudgetMs) || remainingBudgetMs <= 0) { fail("ARGUMENT_INVALID", "An exact pinned guest and positive bounded observation budget are required."); return result; }
  const remote = [
    `test "$(cat /etc/fleur-owned-guest)" = '${target.nonce}'`, "cd lab",
    event("bun-preparation", "started"), "FLEUR_GUEST_PREPARATION_EVENTS=yes python3 -I prepare-fresh-linux-guest.py", event("bun-preparation", "completed"),
    event("candidate-extraction", "started"), "tar -xzf fleur-internal-native-candidate.tgz", event("candidate-extraction", "completed"),
    event("restriction-extraction", "started"), "tar -xf runtime-probe.tar", event("restriction-extraction", "completed"), event("complete", "completed"),
  ].join(" && ");
  // Starting the shared helper is inside this observation's original clock.
  const child = startRetainedSsh(["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remote]);
  const terminate = () => child.requestTermination();
  let interrupt: (reason: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const timer = setTimeout(() => { result.transport.deadlineFired = true; terminate(); interrupt(new Error("deadline")); }, Math.max(1, timeoutMs - (performance.now() - started)));
  const finished = child.finished.then((code) => { result.transport.exitCode = code; result.transport.signal = child.signal; });
  const bunSequence = bunStages.filter((stage) => stage !== "cleanup").flatMap((stage) => [`${stage}:started`, `${stage}:completed`]);
  const artifactSequence = ["bun-preparation:started", "bun-preparation:completed", "candidate-extraction:started", "candidate-extraction:completed", "restriction-extraction:started", "restriction-extraction:completed", "complete:completed"];
  let bunPosition = 0; let artifactPosition = 0; let cleanupPosition = 0; let guestElapsed = -1;
  function frame(line: string) {
    if (line.length > 65536) throw new Error("protocol");
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("protocol");
    const record = value as Record<string, unknown>;
    if (record.formatVersion !== 1) throw new Error("protocol");
    if (record.scope === "guest-bun-preparation" && typeof record.ok === "boolean" && !result.bun) {
      if (artifactPosition !== 1 || (record.ok && (bunPosition !== bunSequence.length || cleanupPosition !== 0))) throw new Error("protocol");
      const bun: Record<string, unknown> = { formatVersion: 1, scope: "guest-bun-preparation", ok: record.ok };
      if (typeof record.ownedPartialRemoved === "boolean") bun.ownedPartialRemoved = record.ownedPartialRemoved;
      if (record.ok) {
        if (record.archiveSha256 !== archiveSha256 || !Number.isSafeInteger(record.archiveBytes) || Number(record.archiveBytes) <= 0 || Number(record.archiveBytes) > 160 * 1024 * 1024 || !Number.isSafeInteger(record.executableBytes) || Number(record.executableBytes) <= 0 || Number(record.executableBytes) > 256 * 1024 * 1024 || typeof record.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.executableSha256)) throw new Error("protocol");
        Object.assign(bun, { archiveSha256, archiveBytes: record.archiveBytes, executableBytes: record.executableBytes, executableSha256: record.executableSha256 });
      }
      result.bun = bun;
      return;
    }
    const allowed = record.scope === "guest-bun-preparation-event" ? bunStages : record.scope === "guest-artifact-preparation-event" ? artifactStages : [];
    if (typeof record.stage !== "string" || !allowed.includes(record.stage) || !["started", "completed"].includes(String(record.state)) || result.stages.length >= 32 || (record.elapsedMs !== undefined && (!Number.isSafeInteger(record.elapsedMs) || Number(record.elapsedMs) < 0 || Number(record.elapsedMs) > 24 * 60 * 60 * 1000))) throw new Error("protocol");
    const key = `${record.stage}:${record.state}`;
    if (record.scope === "guest-bun-preparation-event") {
      // Source producer elapsed times are relative integer milliseconds. Compare
      // their order/budget only, never guest clock epochs with host timestamps.
      if (artifactPosition !== 1 || result.bun || !Number.isSafeInteger(record.elapsedMs) || Number(record.elapsedMs) < guestElapsed || Number(record.elapsedMs) > timeoutMs) throw new Error("protocol");
      if (record.stage === "cleanup") {
        if (bunPosition < 5 || cleanupPosition >= 2 || key !== ["cleanup:started", "cleanup:completed"][cleanupPosition]) throw new Error("protocol");
        cleanupPosition++;
      } else {
        if (cleanupPosition !== 0 || key !== bunSequence[bunPosition]) throw new Error("protocol");
        bunPosition++;
      }
      guestElapsed = Number(record.elapsedMs);
    } else {
      if (record.elapsedMs !== undefined || key !== artifactSequence[artifactPosition] || (artifactPosition === 1 && result.bun?.ok !== true)) throw new Error("protocol");
      artifactPosition++;
    }
    const stage: Stage = { stage: record.stage, state: record.state as Stage["state"], hostElapsedMs: Math.round(performance.now() - started), ...(record.elapsedMs === undefined ? {} : { guestElapsedMs: Number(record.elapsedMs) }) };
    result.stages.push(stage); result.lastStage = stage;
  }
  function rejectEvidence(code: string, message: string) {
    result.evidenceError ??= { code, message }; fail(code, message);
    // Protocol rejection latches failure without racing an already-exiting
    // retained leader. The original watchdog still bounds discard/drain.
    // Exceeding the total byte cap requires immediate termination.
    if (code === "PREPARATION_OUTPUT_LIMIT") { terminate(); interrupt(new Error("evidence")); }
  }
  async function read(stream: Readable, kind: "stdoutBytes" | "stderrBytes") {
    let pending = ""; let decode = true;
    for await (const chunk of stream) {
      const part = Buffer.from(chunk); result.transport[kind] += part.length;
      if (result.transport.stdoutBytes + result.transport.stderrBytes > 2 * 1024 * 1024) {
        result.transport.outputLimitExceeded = true;
        rejectEvidence("PREPARATION_OUTPUT_LIMIT", "Preparation output exceeded its bounded evidence budget."); decode = false; pending = "";
      }
      if (kind === "stderrBytes" || !decode) continue;
      // After rejecting a frame, discard rather than destroy this stream. The
      // retained helper still needs bounded drain/EOF to retire its SSH child.
      pending += part.toString("utf8");
      try {
        if (pending.length > 65536 && !pending.includes("\n")) throw new Error("protocol");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) frame(line); }
      } catch { rejectEvidence("PREPARATION_PROTOCOL_INVALID", "Preparation did not emit complete allowlisted stage evidence."); decode = false; pending = ""; }
    }
    if (pending) rejectEvidence("PREPARATION_PROTOCOL_INVALID", "Preparation ended with incomplete allowlisted stage evidence.");
  }
  try { await Promise.race([Promise.all([read(child.stdout, "stdoutBytes"), read(child.stderr, "stderrBytes"), finished]), interrupted, child.signalFailed]); }
  catch { if (!result.transport.deadlineFired) fail("PREPARATION_TRANSPORT_FAILED", "The retained preparation transport failed before completing its evidence."); terminate(); }
  finally {
    clearTimeout(timer); result.transport.elapsedMs = Math.round(performance.now() - started);
    const cleanupStarted = performance.now();
    try { await child.cleanup(); result.localCleanup = { retired: true, elapsedMs: Math.round(performance.now() - cleanupStarted), budgetMs: 3000 }; }
    catch (error) {
      const survivor = error instanceof Error && error.message === "A surviving owned SSH process group invalidated its completed leader";
      const cleanupError = survivor
        ? { code: "PREPARATION_SURVIVOR", message: "A live local descendant invalidated its completed SSH leader's proof; the owned group was retired." }
        : { code: "PREPARATION_CLEANUP_UNCONFIRMED", message: "Local SSH cleanup could not establish an uncontested, fully retired transport." };
      result.localCleanup = { retired: survivor, elapsedMs: Math.round(performance.now() - cleanupStarted), budgetMs: 3000, error: cleanupError };
      if (!result.evidenceError) result.error = cleanupError;
    }
  }
  if (result.transport.deadlineFired && !(["PREPARATION_CLEANUP_UNCONFIRMED", "PREPARATION_SURVIVOR"].includes(result.error?.code ?? ""))) result.error = { code: "PREPARATION_HOST_DEADLINE", message: "The unchanged host preparation deadline expired; guest completion is unconfirmed." };
  else if (!result.error && result.transport.exitCode !== 0) fail("PREPARATION_COMMAND_EXIT", "Preparation transport or remote command exited unsuccessfully; stage evidence identifies only the last observed work.");
  if (!result.error && (result.bun?.ok !== true || result.lastStage?.stage !== "complete" || result.lastStage.state !== "completed" || artifactPosition !== artifactSequence.length || bunPosition !== bunSequence.length || cleanupPosition !== 0)) fail("PREPARATION_INCOMPLETE", "Preparation success lacks Bun identity or both complete archive operations.");
  result.ok = !result.error; return result;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const valid = (args.length === 8 || (args.length === 10 && args[8] === "--budget-ms")) && args[0] === "--port" && args[2] === "--identity" && args[4] === "--known-hosts" && args[6] === "--nonce";
  const target = { port: valid ? Number(args[1]) : NaN, identity: args[3] ?? "", knownHosts: args[5] ?? "", nonce: args[7] ?? "" };
  const result = await observePreparation(target, args.length === 10 && args[8] === "--budget-ms" ? Number(args[9]) : 10000);
  process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.ok ? 0 : 4;
}
