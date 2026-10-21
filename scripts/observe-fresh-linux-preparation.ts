import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { BootTarget } from "./observe-fresh-linux-boot.ts";
interface Stage { stage: string; state: "started" | "completed"; hostElapsedMs: number; guestElapsedMs?: number }
export interface PreparationObservation {
  formatVersion: 1; scope: "fresh-linux-preparation-observation"; ok: boolean;
  transport: { timeoutMs: number; elapsedMs: number; deadlineFired: boolean; exitCode: number | null; signal: string | null; stdoutBytes: number; stderrBytes: number };
  stages: Stage[]; lastStage: Stage | null; bun?: Record<string, unknown>;
  error?: { code: string; message: string };
}
const bunStages = ["archive-authentication", "zip-entry-validation", "executable-extraction", "retained-output-authentication", "archive-reauthentication", "output-custody", "cleanup"];
const artifactStages = ["bun-preparation", "candidate-extraction", "restriction-extraction", "complete"];
const archiveSha256 = "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18";
// The relay deliberately remains the live process-group leader after SSH exits.
// Descriptor 3 carries only the child exit tuple. The host retires that retained
// group before reaping it, including local descendants retaining SSH pipes.
const relay = `import json,os,selectors,signal,subprocess,sys,time
try:
 child=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 selector=selectors.DefaultSelector()
 selector.register(child.stdout,selectors.EVENT_READ,1);selector.register(child.stderr,selectors.EVENT_READ,2)
 while selector.get_map():
  for key,_ in selector.select():
   block=os.read(key.fileobj.fileno(),8192)
   if block:os.write(key.data,block)
   else:selector.unregister(key.fileobj)
 code=child.wait()
 detail={'exitCode':code if code>=0 else 128-code,'signal':None if code>=0 else signal.Signals(-code).name}
except Exception:
 detail={'relayError':True}
os.write(3,(json.dumps(detail)+'\\n').encode())
while True:time.sleep(3600)
`;
const event = (stage: string, state: string) => `printf '${JSON.stringify({ formatVersion: 1, scope: "guest-artifact-preparation-event", stage, state })}\\n'`;
/** The original ten-second preparation boundary, with allowlisted partial evidence. */
export async function observePreparation(target: BootTarget, remainingBudgetMs = 10000): Promise<PreparationObservation> {
  const timeoutMs = Math.max(1, Math.min(10000, remainingBudgetMs)); const started = performance.now();
  const result: PreparationObservation = { formatVersion: 1, scope: "fresh-linux-preparation-observation", ok: false, transport: { timeoutMs, elapsedMs: 0, deadlineFired: false, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0 }, stages: [], lastStage: null };
  const fail = (code: string, message: string) => { result.error ??= { code, message }; };
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts || !Number.isFinite(remainingBudgetMs) || remainingBudgetMs <= 0) { fail("ARGUMENT_INVALID", "An exact pinned guest and positive bounded observation budget are required."); return result; }
  const remote = [
    `test "$(cat /etc/fleur-owned-guest)" = '${target.nonce}'`, "cd lab",
    event("bun-preparation", "started"), "FLEUR_GUEST_PREPARATION_EVENTS=yes python3 -I prepare-fresh-linux-guest.py", event("bun-preparation", "completed"),
    event("candidate-extraction", "started"), "tar -xzf fleur-internal-native-candidate.tgz", event("candidate-extraction", "completed"),
    event("restriction-extraction", "started"), "tar -xf runtime-probe.tar", event("restriction-extraction", "completed"), event("complete", "completed"),
  ].join(" && ");
  const child = spawn("python3", ["-I", "-c", relay, "ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remote], { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...process.env, SSH_AUTH_SOCK: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined } });
  let killing = false; let childStatus = false;
  const kill = () => {
    if (killing || !child.pid) return; killing = true;
    // Signal only the still-running owned transport, never a completed PID.
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") fail("PREPARATION_CLEANUP_UNCONFIRMED", "Owned transport termination could not be confirmed."); }
    }
  };
  let interrupt: (reason: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
  const timer = setTimeout(() => { result.transport.deadlineFired = true; kill(); interrupt(new Error("deadline")); }, timeoutMs);
  const finished = new Promise<void>((resolve) => { child.once("error", () => { fail("PREPARATION_TRANSPORT_SPAWN", "The preparation transport could not start."); resolve(); }); child.once("close", (code, signal) => { if (!childStatus) { result.transport.exitCode = code ?? (signal === "SIGKILL" ? 137 : null); result.transport.signal = signal; if (!result.transport.deadlineFired) fail("PREPARATION_RELAY_FAILED", "The local retained transport leader ended without child-exit evidence."); } resolve(); }); });
  async function control() {
    let pending = ""; let seen = false;
    for await (const chunk of child.stdio[3] as Readable) {
      pending += Buffer.from(chunk).toString("utf8");
      if (pending.length > 1024) throw new Error("control");
      if (!pending.endsWith("\n")) continue;
      if (seen) throw new Error("control");
      const value = JSON.parse(pending) as { exitCode?: unknown; signal?: unknown };
      if (!Number.isInteger(value.exitCode) || Number(value.exitCode) < 0 || Number(value.exitCode) > 255 || (value.signal !== null && (typeof value.signal !== "string" || !/^SIG[A-Z0-9]+$/.test(value.signal)))) throw new Error("control");
      childStatus = true; seen = true; result.transport.exitCode = Number(value.exitCode); result.transport.signal = value.signal as string | null;
      kill();
    }
  }
  function frame(line: string) {
    if (line.length > 65536) throw new Error("protocol");
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("protocol");
    const record = value as Record<string, unknown>;
    if (record.formatVersion !== 1) throw new Error("protocol");
    if (record.scope === "guest-bun-preparation" && typeof record.ok === "boolean" && !result.bun) {
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
    const stage: Stage = { stage: record.stage, state: record.state as Stage["state"], hostElapsedMs: Math.round(performance.now() - started), ...(record.elapsedMs === undefined ? {} : { guestElapsedMs: Number(record.elapsedMs) }) };
    result.stages.push(stage); result.lastStage = stage;
  }
  async function read(stream: Readable, kind: "stdoutBytes" | "stderrBytes") {
    let pending = "";
    for await (const chunk of stream) {
      const part = Buffer.from(chunk); result.transport[kind] += part.length;
      if (result.transport.stdoutBytes + result.transport.stderrBytes > 2 * 1024 * 1024) { fail("PREPARATION_OUTPUT_LIMIT", "Preparation output exceeded its bounded evidence budget."); kill(); throw new Error("output"); }
      if (kind === "stderrBytes") continue; // Count diagnostics, never publish raw transport output.
      pending += part.toString("utf8"); if (pending.length > 65536 && !pending.includes("\n")) throw new Error("protocol");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line) frame(line); }
    }
    if (pending) throw new Error("protocol");
  }
  try { await Promise.race([Promise.all([read(child.stdout!, "stdoutBytes"), read(child.stderr!, "stderrBytes"), control(), finished]), interrupted]); }
  catch {
    fail("PREPARATION_PROTOCOL_INVALID", "Preparation did not emit complete allowlisted stage evidence."); kill();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([finished, new Promise<never>((_resolve, reject) => { cleanupTimer = setTimeout(() => reject(new Error("cleanup")), 3000); })]); }
    catch { result.error = { code: "PREPARATION_CLEANUP_UNCONFIRMED", message: "The local preparation transport did not retire within its separate three-second cleanup bound." }; child.stdout?.destroy(); child.stderr?.destroy(); (child.stdio[3] as Readable | null)?.destroy(); }
    finally { clearTimeout(cleanupTimer); }
  }
  finally { clearTimeout(timer); result.transport.elapsedMs = Math.round(performance.now() - started); }
  if (result.transport.deadlineFired && result.error?.code !== "PREPARATION_CLEANUP_UNCONFIRMED") result.error = { code: "PREPARATION_HOST_DEADLINE", message: "The unchanged host preparation deadline expired; guest completion is unconfirmed." };
  else if (!result.error && result.transport.exitCode !== 0) fail("PREPARATION_COMMAND_EXIT", "Preparation transport or remote command exited unsuccessfully; stage evidence identifies only the last observed work.");
  const expected = ["bun-preparation:started", "bun-preparation:completed", "candidate-extraction:started", "candidate-extraction:completed", "restriction-extraction:started", "restriction-extraction:completed", "complete:completed"];
  const observed = result.stages.filter((item) => artifactStages.includes(item.stage)).map((item) => `${item.stage}:${item.state}`);
  if (!result.error && (result.bun?.ok !== true || result.lastStage?.stage !== "complete" || result.lastStage.state !== "completed" || JSON.stringify(observed) !== JSON.stringify(expected))) fail("PREPARATION_INCOMPLETE", "Preparation success lacks Bun identity or both complete archive operations.");
  result.ok = !result.error; return result;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const valid = (args.length === 8 || (args.length === 10 && args[8] === "--budget-ms")) && args[0] === "--port" && args[2] === "--identity" && args[4] === "--known-hosts" && args[6] === "--nonce";
  const target = { port: valid ? Number(args[1]) : NaN, identity: args[3] ?? "", knownHosts: args[5] ?? "", nonce: args[7] ?? "" };
  const result = await observePreparation(target, args.length === 10 && args[8] === "--budget-ms" ? Number(args[9]) : 10000);
  process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.ok ? 0 : 4;
}
