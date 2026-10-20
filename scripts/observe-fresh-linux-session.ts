import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
export interface SessionTarget { port: number; identity: string; knownHosts: string; nonce: string }
export interface SessionObservation { formatVersion: 1; scope: "fresh-linux-session-observation"; ok: boolean; guest?: Record<string, unknown>; initialGuest?: Record<string, unknown>; error?: { code: string; message: string } }
const failure = (code: string, message: string): SessionObservation => ({ formatVersion: 1, scope: "fresh-linux-session-observation", ok: false, error: { code, message } });
async function bounded(stream: Readable): Promise<string> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) { const part = Buffer.from(chunk); bytes += part.length; if (bytes > 2 * 1024 * 1024) throw new Error("Session output exceeded its bound"); parts.push(part); }
  return Buffer.concat(parts).toString("utf8");
}
/** Own the guest workflow transport; artifact authentication remains the caller's gate. */
export async function observeGuestSessions(target: SessionTarget, signal?: AbortSignal): Promise<SessionObservation> {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts) return failure("ARGUMENT_INVALID", "An exact pinned loopback guest target is required.");
  const deadline = performance.now() + 900000;
  const remaining = () => { const value = deadline - performance.now(); if (value <= 0 || signal?.aborted) throw new Error("Guest session aggregate deadline expired or was cancelled"); return Math.ceil(value); };
  async function ssh(remote: string): Promise<{ code: number; guest: Record<string, unknown> }> {
    const timeout = remaining();
    const child = spawn("ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remote], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SSH_AUTH_SOCK: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined } });
    const finished = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 137)); });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
    const timer = setTimeout(kill, timeout); signal?.addEventListener("abort", kill, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([bounded(child.stdout!), bounded(child.stderr!), finished]);
      remaining();
      if (![0, 3, 4].includes(code)) throw new Error(`SSH workflow exited ${code}: ${stderr.slice(-2048)}`);
      const parsed: unknown = JSON.parse(stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Guest report is not an object");
      return { code, guest: parsed as Record<string, unknown> };
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", kill);
      let survivor = false;
      if (child.pid && child.exitCode !== null) {
        try { process.kill(-child.pid, 0); survivor = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      kill(); await finished.catch(() => {});
      if (child.pid) {
        const stop = performance.now() + 3000;
        while (true) {
          try { process.kill(-child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
          if (performance.now() >= stop) throw new Error("Owned SSH process group cleanup is unconfirmed");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      if (survivor) throw new Error("A surviving owned SSH process group invalidated its completed leader");
    }
  }
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
          || !Array.isArray(after.accountGroups) || !Array.isArray(after.sessionGroups) || !after.accountGroups.includes(after.group.gid) || after.sessionGroups.includes(after.group.gid)) throw new Error("Intermediate guest handoff is invalid");
      const resumed = await ssh(`python3 lab/fresh-linux-guest.py ${target.nonce} --resume ${checkpoint.sha256}`);
      const final = resumed.guest;
      const access = final.accessResume as { checkpointSha256?: unknown; sessionGroups?: unknown } | undefined;
      if (resumed.code === 3 || final.phase !== undefined || final.formatVersion !== 1 || final.runtimeSupport !== "unverified" || final.humanConsentProof !== false || !isDeepStrictEqual(final.baseline, guest.baseline)
          || access?.checkpointSha256 !== checkpoint.sha256 || !isDeepStrictEqual(access.sessionGroups, after.accountGroups)) throw new Error("Resumed ordinary login report differs from its anchored handoff");
      return { formatVersion: 1, scope: "fresh-linux-session-observation", ok: resumed.code === 0 && final.ok === true, initialGuest: guest, guest: final };
    }
    return { formatVersion: 1, scope: "fresh-linux-session-observation", ok: observed.code === 0 && guest.ok === true, guest };
  } catch (error) { return { ...failure("SESSION_FAILED", error instanceof Error ? error.message : "Guest session failed"), ...(initialGuest ? { initialGuest } : {}) }; }
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
