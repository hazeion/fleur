import type { Readable } from "node:stream";
import { startRetainedSsh } from "./retained-ssh.ts";

interface CustodyTarget { port: number; identity: string; knownHosts: string; nonce: string }
/** Transport evidence only. The caller separately validates the root custody JSON. */
export async function observeOwnedGuestCustody(target: CustodyTarget, remainingBudgetMs: number, signal?: AbortSignal) {
  const started = performance.now();
  const timeoutMs = Math.floor(Math.min(10000, remainingBudgetMs));
  const transport = { timeoutMs, elapsedMs: 0, deadlineFired: false, terminationRequested: false, exitCode: null as number | null, signal: null as string | null, stdoutBytes: 0, stderrBytes: 0, outputLimitExceeded: false };
  const localCleanup = { retired: false, budgetMs: 3000, error: undefined as string | undefined };
  let error: { code: string; message: string } | undefined;
  let stdout = "";
  const finish = () => ({ formatVersion: 1, scope: "owned-guest-custody-transport", ok: !error, runtimeAdmission: false, transport, localCleanup, ...(error ? { error } : {}), stdout });
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !target.identity || !target.knownHosts || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(target.nonce) || !Number.isFinite(timeoutMs) || timeoutMs < 1 || signal?.aborted) {
    error = { code: "ARGUMENT_INVALID", message: "A complete pinned transport and unexpired custody budget are required." }; return finish();
  }
  const remote = `python3 -I /usr/local/lib/fleur-owned-guest.py --owned-guest-nonce ${target.nonce} --budget-seconds ${timeoutMs / 1000}`;
  const child = startRetainedSsh(["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remote]);
  const fail = (code: string, message: string) => { error ??= { code, message }; };
  const timer = setTimeout(() => { transport.deadlineFired = true; fail("HOST_DEADLINE", "Custody transport exceeded its original work budget."); child.requestTermination(); }, Math.max(0, started + timeoutMs - performance.now()));
  const cancel = () => { fail("CANCELLED", "Owned guest custody observation was cancelled."); child.requestTermination(); };
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
  let total = 0;
  const drain = async (stream: Readable, output: boolean) => {
    const parts: Buffer[] = [];
    for await (const chunk of stream) {
      const part = Buffer.from(chunk); total += part.length;
      if (output) transport.stdoutBytes += part.length; else transport.stderrBytes += part.length;
      if (total > 2 * 1024 * 1024) { transport.outputLimitExceeded = true; fail("OUTPUT_LIMIT", "Custody transport output exceeded its bound."); child.requestTermination(); }
      else if (output) parts.push(part);
    }
    return output ? Buffer.concat(parts).toString("utf8") : "";
  };
  try {
    const [body] = await Promise.race([Promise.all([drain(child.stdout, true), drain(child.stderr, false), child.finished]), child.signalFailed]); stdout = body;
    if (performance.now() >= started + timeoutMs) { transport.deadlineFired = true; fail("HOST_DEADLINE", "Custody transport exceeded its original work budget."); }
    if (child.exitCode !== 0 || child.signal !== null) fail("SSH_FAILED", "Custody transport did not exit normally with status zero.");
  } catch { fail("TRANSPORT_FAILED", "Custody transport completion could not be established."); child.requestTermination(); }
  finally {
    clearTimeout(timer); signal?.removeEventListener("abort", cancel);
    try { await child.cleanup(); localCleanup.retired = true; }
    catch (caught) {
      const survivor = caught instanceof Error && caught.message === "A surviving owned SSH process group invalidated its completed leader";
      localCleanup.retired = survivor;
      localCleanup.error = survivor ? "SURVIVING_GROUP_REFUSED" : "CLEANUP_UNCONFIRMED";
      fail(survivor ? "SURVIVING_GROUP_REFUSED" : "CLEANUP_UNCONFIRMED", "Custody transport did not prove a clean completed process group.");
    }
    transport.exitCode = child.exitCode; transport.signal = child.signal; transport.terminationRequested = child.terminationRequested; transport.elapsedMs = Math.round(performance.now() - started);
  }
  return finish();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valid = args.length === 10 && args[0] === "--port" && args[2] === "--identity" && args[4] === "--known-hosts" && args[6] === "--nonce" && args[8] === "--budget-ms";
  const observed = await observeOwnedGuestCustody({ port: valid ? Number(args[1]) : 0, identity: args[3] ?? "", knownHosts: args[5] ?? "", nonce: args[7] ?? "" }, valid ? Number(args[9]) : 0);
  const publicResult = { ...observed, stdout: undefined };
  process.stdout.write(JSON.stringify(publicResult) + "\n"); process.exitCode = observed.ok ? 0 : 4;
}
