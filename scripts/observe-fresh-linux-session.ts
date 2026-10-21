import { isDeepStrictEqual } from "node:util";
import { prepareRetainedSsh, startRetainedSsh } from "./retained-ssh.ts";
import type { Readable } from "node:stream";
export interface SessionTarget { port: number; identity: string; knownHosts: string; nonce: string }
export interface SessionObservation { formatVersion: 1; scope: "fresh-linux-session-observation"; ok: boolean; guest?: Record<string, unknown>; initialGuest?: Record<string, unknown>; error?: { code: string; message: string } }
const failure = (code: string, message: string): SessionObservation => ({ formatVersion: 1, scope: "fresh-linux-session-observation", ok: false, error: { code, message } });
async function bounded(stream: Readable, prefix = "", started?: () => void): Promise<string> {
  const parts: Buffer[] = []; let bytes = 0; let matched = 0;
  const expected = Buffer.from(prefix);
  for await (const chunk of stream) {
    const part = Buffer.from(chunk); bytes += part.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("Session output exceeded its bound");
    if (matched < expected.length) {
      const count = Math.min(part.length, expected.length - matched);
      if (!part.subarray(0, count).equals(expected.subarray(matched, matched + count))) throw new Error("SSH session start marker is invalid");
      matched += count;
      if (matched === expected.length) started?.();
    }
    parts.push(part);
  }
  return Buffer.concat(parts).subarray(expected.length).toString("utf8");
}
function numericGroups(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((gid) => Number.isSafeInteger(gid) && gid >= 0) && new Set(value).size === value.length;
}
function checkTerminalProof(code: number, guest: Record<string, unknown>): void {
  if (typeof guest.ok !== "boolean" || (code === 0) !== guest.ok) throw new Error("Guest final proof contradicts its exit status");
  if (!guest.ok) return;
  const restriction = guest.restrictionProbe as { exitCode?: unknown; result?: { bounded_probe_passed?: unknown; cleanup_complete?: unknown } } | undefined;
  if (guest.installationEvidence !== "verified-full-system-guest" || !guest.baseline || !Array.isArray(guest.runs) || guest.runs.length !== 2 || guest.sentinelCleanup !== true || restriction?.exitCode !== 0 || restriction.result?.bounded_probe_passed !== true || restriction.result.cleanup_complete !== true) throw new Error("Guest final proof is incomplete");
  for (const item of guest.runs) {
    const observed = item as { exitCode?: unknown; result?: { formatVersion?: unknown; command?: unknown; ok?: unknown; truncated?: unknown; error?: { code?: unknown }; data?: { components?: Record<string, { state?: unknown; cleanup?: unknown }> } } };
    const envelope = observed?.result; const components = envelope?.data?.components;
    if (observed?.exitCode !== 4 || envelope?.formatVersion !== 1 || envelope.command !== "doctor" || envelope.ok !== false || envelope.truncated !== false || envelope.error?.code !== "PREREQUISITE_UNAVAILABLE"
        || !["cli", "daemon", "compose", "smoke"].every((name) => components?.[name]?.state === "ready") || components?.smoke?.cleanup !== true || components?.release?.state !== "unverified") throw new Error("Guest final proof lacks the complete release-unverified doctor rounds");
  }
}
/** Own the guest workflow transport; artifact authentication remains the caller's gate. */
export async function observeGuestSessions(target: SessionTarget, signal?: AbortSignal): Promise<SessionObservation> {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts) return failure("ARGUMENT_INVALID", "An exact pinned loopback guest target is required.");
  const deadline = performance.now() + 900000;
  const remaining = () => { const value = deadline - performance.now(); if (value <= 0 || signal?.aborted) throw new Error("Guest session aggregate deadline expired or was cancelled"); return Math.ceil(value); };
  // At most one resume connection is possible. Its idle helper owns no SSH.
  const resumeRelay = prepareRetainedSsh(); let connections = 0;
  async function ssh(remote: string): Promise<{ code: number; guest: Record<string, unknown> }> {
    const timeout = remaining();
    const readyPrefix = `FLEUR_SESSION_READY=${target.nonce}\n`;
    const remoteCommand = `printf 'FLEUR_SESSION_READY=${target.nonce}\\n'; exec ${remote}`;
    const connection = connections++;
    const child = startRetainedSsh(["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remoteCommand], connection === 1 ? resumeRelay : undefined, connection === 0 ? resumeRelay.ready : undefined);
    const finished = child.finished;
    const signalFailed = child.signalFailed;
    const requestTermination = child.requestTermination;
    let startExpired = false; let sessionStarted = false;
    const startTimer = setTimeout(() => { startExpired = true; requestTermination(); }, Math.min(10000, timeout));
    const timer = setTimeout(requestTermination, timeout); signal?.addEventListener("abort", requestTermination, { once: true });
    const cleanup = async () => {
      clearTimeout(startTimer); clearTimeout(timer); signal?.removeEventListener("abort", requestTermination);
      await child.cleanup();
    };
    try {
      const [stdout, stderr, code] = await Promise.race([Promise.all([bounded(child.stdout!, readyPrefix, () => { sessionStarted = true; clearTimeout(startTimer); }), bounded(child.stderr!), finished]), signalFailed]);
      remaining();
      if (startExpired) throw new Error("SSH session start deadline expired");
      if (![0, 3, 4].includes(code)) throw new Error(`SSH workflow exited ${code}: ${stderr.slice(-2048)}`);
      if (!sessionStarted) throw new Error("SSH session start marker was absent or incomplete");
      const parsed: unknown = JSON.parse(stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Guest report is not an object");
      return { code, guest: parsed as Record<string, unknown> };
    } catch (error) {
      if (startExpired) throw new Error("SSH session start deadline expired");
      throw error;
    } finally { await cleanup(); }
  }
  const observe = async (): Promise<SessionObservation> => {
    let initialGuest: Record<string, unknown> | undefined;
    try {
      const observed = await ssh(`python3 lab/fresh-linux-guest.py ${target.nonce}`);
      const guest = observed.guest; initialGuest = guest;
      if (guest.formatVersion !== 1 || guest.runtimeSupport !== "unverified" || guest.humanConsentProof !== false) throw new Error("Guest metadata differs from its declared scope");
      if (observed.code === 3 || guest.phase !== undefined) {
        const checkpoint = guest.checkpoint as { sha256?: unknown; bytes?: unknown } | undefined;
        const handoff = guest.accessHandoff as { after?: { user?: { name?: unknown; uid?: unknown }; group?: { gid?: unknown }; accountGroups?: unknown; sessionGroups?: unknown } } | undefined;
        const after = handoff?.after;
        if (observed.code !== 3 || guest.phase !== "new-login-required" || guest.ok !== false || guest.installationEvidence !== "pending" || !guest.baseline || !checkpoint || typeof checkpoint.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.sha256)
            || typeof checkpoint.bytes !== "number" || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes <= 0 || checkpoint.bytes > 2 * 1024 * 1024 - 65536
            || after?.user?.name !== "fleur" || typeof after.user.uid !== "number" || !Number.isSafeInteger(after.user.uid) || after.user.uid <= 0 || typeof after.group?.gid !== "number"
            || !numericGroups(after.accountGroups) || !numericGroups(after.sessionGroups) || !after.accountGroups.includes(after.group.gid) || after.sessionGroups.includes(after.group.gid)) throw new Error("Intermediate guest handoff is invalid");
        const expectedGroups = after.accountGroups;
        const resumed = await ssh(`python3 lab/fresh-linux-guest.py ${target.nonce} --resume ${checkpoint.sha256}`);
        const final = resumed.guest;
        const access = final.accessResume as { checkpointSha256?: unknown; sessionGroups?: unknown } | undefined;
        if (resumed.code === 3 || final.phase !== undefined || final.formatVersion !== 1 || final.runtimeSupport !== "unverified" || final.humanConsentProof !== false || !isDeepStrictEqual(final.baseline, guest.baseline)
            || access?.checkpointSha256 !== checkpoint.sha256 || !numericGroups(access.sessionGroups) || access.sessionGroups.length !== expectedGroups.length || !access.sessionGroups.every((gid) => expectedGroups.includes(gid))) throw new Error("Resumed ordinary login report differs from its anchored handoff");
        checkTerminalProof(resumed.code, final);
        return { formatVersion: 1, scope: "fresh-linux-session-observation", ok: resumed.code === 0 && final.ok === true, initialGuest: guest, guest: final };
      }
      checkTerminalProof(observed.code, guest);
      return { formatVersion: 1, scope: "fresh-linux-session-observation", ok: observed.code === 0 && guest.ok === true, guest };
    } catch (error) { return { ...failure("SESSION_FAILED", error instanceof Error ? error.message : "Guest session failed"), ...(initialGuest ? { initialGuest } : {}) }; }
  };
  const observed = await observe();
  try { await resumeRelay.close(); }
  catch (error) { return failure("SESSION_FAILED", error instanceof Error ? error.message : "Idle resume relay cleanup is unconfirmed"); }
  return observed;
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const observed = args.length === 8 && args[0] === "--port" && args[2] === "--identity" && args[4] === "--known-hosts" && args[6] === "--nonce"
    ? await observeGuestSessions({ port: Number(args[1]), identity: args[3]!, knownHosts: args[5]!, nonce: args[7]! }, cancellation.signal)
    : failure("ARGUMENT_INVALID", "Use --port <port> --identity <key> --known-hosts <pins> --nonce <nonce>.");
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  process.stdout.write(JSON.stringify(observed) + "\n"); process.exitCode = observed.ok ? 0 : 4;
}
