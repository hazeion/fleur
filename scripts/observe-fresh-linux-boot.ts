import { startRetainedSsh } from "./retained-ssh.ts";
import type { Readable } from "node:stream";
export interface BootTarget { port: number; identity: string; knownHosts: string; nonce: string }
export interface BootTransport {
  timeoutMs: number; elapsedMs: number; deadlineFired: boolean;
  /** A host request, not proof of signal delivery or its effect on SSH. */
  terminationRequested: boolean;
  exitCode: number | null; signal: string | null; stdoutBytes: number; stderrBytes: number; cleanupConfirmed: boolean;
}
export interface BootObservation { formatVersion: 1; scope: "fresh-linux-boot-observation"; ok: boolean; state: "ready" | "pending" | "failed"; cloudInitComplete?: boolean; nonceMatched?: boolean; transport?: BootTransport; error?: { code: string; message: string } }
const result = (state: BootObservation["state"], error?: BootObservation["error"]): BootObservation => ({ formatVersion: 1, scope: "fresh-linux-boot-observation", ok: state === "ready", state, ...(error ? { error } : {}) });
async function bounded(stream: Readable, counted: (bytes: number) => void): Promise<string> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of stream) { const part = Buffer.from(chunk); size += part.length; counted(size); if (size > 2 * 1024 * 1024) throw new Error("Boot observation output exceeded its limit"); parts.push(part); }
  return Buffer.concat(parts).toString("utf8");
}
/** One bounded observation of an owned guest through its pinned loopback SSH transport. */
export async function observeBoot(target: BootTarget, remainingBudgetMs = 10000, signal?: AbortSignal): Promise<BootObservation> {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts) return result("failed", { code: "ARGUMENT_INVALID", message: "A pinned loopback transport and exact guest nonce are required." });
  const started = performance.now();
  const transport: BootTransport = { timeoutMs: Math.max(1, Math.min(10000, remainingBudgetMs)), elapsedMs: 0, deadlineFired: false, terminationRequested: false, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, cleanupConfirmed: false };
  const remote = [
    "if ! test -f /var/lib/cloud/instance/boot-finished; then exit 75; fi",
    "cloud-init status --format=json",
    'status=$?; if [ "$status" -ne 0 ]; then exit "$status"; fi',
    "printf '\\nFLEUR_OWNED_GUEST_NONCE='",
    "cat /etc/fleur-owned-guest",
  ].join("; ");
  const child = startRetainedSsh(["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remote]);
  const timer = setTimeout(() => { transport.deadlineFired = true; child.requestTermination(); }, transport.timeoutMs);
  const cancel = () => child.requestTermination();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const finished = child.finished;
  const observe = async (): Promise<BootObservation> => {
  try {
    const [stdout, stderr, code] = await Promise.race([Promise.all([bounded(child.stdout!, (bytes) => { transport.stdoutBytes = bytes; }), bounded(child.stderr!, (bytes) => { transport.stderrBytes = bytes; }), finished]), child.signalFailed]);
    if (code === 75) return result("pending");
    const preAuthenticationReset = `kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 127.0.0.1 port ${target.port}\r\n`;
    if (code === 255 && stdout === "" && (stderr === preAuthenticationReset || stderr === preAuthenticationReset.replaceAll("\r\n", "\n"))) return result("pending");
    if (code === 255 && /(?:connect to host 127\.0\.0\.1 port [0-9]+: Connection (?:refused|timed out)|Connection timed out during banner exchange)/.test(stderr)) return result("pending");
    if (code !== 0) return result("failed", { code: "SSH_FAILED", message: `Boot transport exited ${code}: ${stderr.slice(-2048)}` });
    const delimiter = "\nFLEUR_OWNED_GUEST_NONCE="; const split = stdout.indexOf(delimiter);
    if (split < 0 || split !== stdout.lastIndexOf(delimiter) || stdout.slice(split + delimiter.length).replace(/\r?\n$/, "") !== target.nonce) return result("failed", { code: "GUEST_IDENTITY_MISMATCH", message: "Completed boot evidence did not carry the exact owned guest nonce." });
    const status: unknown = JSON.parse(stdout.slice(0, split));
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Cloud-init status is not an object");
    const fields = status as Record<string, unknown>;
    const errorsPresent = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(([key, detail]) => ["errors", "recoverable_errors"].includes(key)
        ? detail !== undefined && (Array.isArray(detail) ? detail.length !== 0 : !detail || typeof detail !== "object" || Object.keys(detail).length !== 0)
        : errorsPresent(detail));
    };
    if (errorsPresent(status)) return result("failed", { code: "CLOUD_INIT_FAILED", message: "Cloud-init reports errors or recovered errors." });
    if (["running", "not started"].includes(String(fields.status))) return result("pending");
    if (fields.status !== "done" || (fields.extended_status !== undefined && fields.extended_status !== "done")) return result("failed", { code: "CLOUD_INIT_FAILED", message: "Cloud-init did not report an exact completed, non-degraded state." });
    return { ...result("ready"), cloudInitComplete: true, nonceMatched: true };
  } catch (error) { return result("failed", { code: "BOOT_OBSERVATION_FAILED", message: error instanceof Error ? error.message : "Boot observation failed" }); }
  };
  let observed = await observe();
  clearTimeout(timer); signal?.removeEventListener("abort", cancel);
  try { await child.cleanup(); transport.cleanupConfirmed = true; }
  catch (error) { observed = result("failed", { code: "BOOT_OBSERVATION_FAILED", message: error instanceof Error ? error.message : "Boot cleanup is unconfirmed" }); }
  transport.exitCode = child.exitCode; transport.signal = child.signal;
  transport.terminationRequested = child.terminationRequested;
  transport.elapsedMs = Math.round(performance.now() - started);
  return { ...observed, transport };
}

export interface BootReadinessOptions { deadline: number; attemptTimeoutMs?: number; signal?: AbortSignal }
export interface BootReadinessObservation { formatVersion: 1; scope: "fresh-linux-boot-readiness"; ok: boolean; state: "ready" | "failed"; lastBootObservation?: BootObservation; error?: { code: string; message: string } }
/** Complete bounded readiness operation; a child observation alone is not readiness. */
export async function waitForGuestBoot(target: BootTarget, options: BootReadinessOptions): Promise<BootReadinessObservation> {
  let lastBootObservation: BootObservation | undefined;
  const finish = (error?: { code: string; message: string }): BootReadinessObservation => ({ formatVersion: 1, scope: "fresh-linux-boot-readiness", ok: !error, state: error ? "failed" : "ready", ...(lastBootObservation ? { lastBootObservation } : {}), ...(error ? { error } : {}) });
  const started = performance.now(); const attemptTimeoutMs = options.attemptTimeoutMs ?? 10000;
  if (!Number.isFinite(options.deadline) || !Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0 || attemptTimeoutMs > 10000) return finish({ code: "ARGUMENT_INVALID", message: "A finite absolute boot deadline and at most ten-second attempts are required." });
  const deadline = Math.min(options.deadline, started + 180000);
  while (true) {
    if (options.signal?.aborted) return finish({ code: "BOOT_FAILED", message: "Owned QEMU exited or boot observation was cancelled." });
    if (performance.now() >= deadline) return finish({ code: "BOOT_TIMEOUT", message: "Guest did not become ready within its original boot deadline." });
    lastBootObservation = await observeBoot(target, Math.min(attemptTimeoutMs, deadline - performance.now()), options.signal);
    if (options.signal?.aborted) return finish({ code: "BOOT_FAILED", message: "Owned QEMU exited or boot observation was cancelled." });
    if (performance.now() >= deadline) return finish({ code: "BOOT_TIMEOUT", message: "Guest did not become ready within its original boot deadline." });
    const transport = lastBootObservation.transport;
    // Retry only the completed empty probe whose own local watchdog expired.
    // This is not a claim that the request caused SSH's exit, nor readiness.
    const locallyExpired = lastBootObservation.state === "failed" && lastBootObservation.error?.code === "SSH_FAILED"
      && lastBootObservation.cloudInitComplete === undefined && lastBootObservation.nonceMatched === undefined
      && transport?.deadlineFired === true && transport.terminationRequested === true && transport.cleanupConfirmed === true
      && transport.exitCode === 255 && transport.signal === null && transport.stdoutBytes === 0 && transport.stderrBytes === 0
      && transport.timeoutMs > 0 && transport.timeoutMs <= 10000 && transport.elapsedMs >= transport.timeoutMs;
    if (lastBootObservation.state === "failed" && !locallyExpired) return finish(lastBootObservation.error ?? { code: "BOOT_FAILED", message: "Guest boot observation failed." });
    if (lastBootObservation.state === "ready") return finish();
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - performance.now()))));
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const observed = args.length === 8 && args[0] === "--port" && args[2] === "--identity" && args[4] === "--known-hosts" && args[6] === "--nonce"
    ? await observeBoot({ port: Number(args[1]), identity: args[3]!, knownHosts: args[5]!, nonce: args[7]! })
    : result("failed", { code: "ARGUMENT_INVALID", message: "Use --port <loopback-port> --identity <key> --known-hosts <pins> --nonce <guest-nonce>." });
  process.stdout.write(JSON.stringify(observed) + "\n"); process.exitCode = observed.state === "ready" ? 0 : observed.state === "pending" ? 3 : 4;
}
