import { checkRecordedInputs, checkOriginalOs } from "./observe-fresh-linux-session.ts";
// Private held native interruption transport. Not release evidence until executed and reviewed.
import { copyOwnedGuestBinding, copyOwnedGuestOsRelease, type OwnedGuestBinding, type OwnedGuestOsRelease } from "./owned-guest-seed.ts";
import { prepareRetainedSsh, startRetainedSsh } from "./retained-ssh.ts";
import type { Readable } from "node:stream";
export interface SessionTarget { port: number; identity: string; knownHosts: string; nonce: string; ownedGuestBinding?: OwnedGuestBinding; ownedGuestOsRelease?: OwnedGuestOsRelease; recordedHelpers?: true; phaseDeadline: number; qualificationSourceSha256: string; interruption?: { checkpointSha256: string; transitionSha256: string } }
export interface SessionObservation { formatVersion: 1; scope: "interrupted-linux-initial-observation"; ok: boolean; guest?: Record<string, unknown>; initialGuest?: Record<string, unknown>; error?: { code: string; message: string } }
const failure = (code: string, message: string): SessionObservation => ({ formatVersion: 1, scope: "interrupted-linux-initial-observation", ok: false, error: { code, message } });
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
/** Own the guest workflow transport; artifact authentication remains the caller's gate. */
export async function observeInterruptionInitial(target: SessionTarget, signal?: AbortSignal): Promise<SessionObservation> {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts) return failure("ARGUMENT_INVALID", "An exact pinned loopback guest target is required.");
  let ownedBinding: Readonly<OwnedGuestBinding> | undefined;
  if (target.ownedGuestBinding !== undefined) {
    try { ownedBinding = copyOwnedGuestBinding(target.ownedGuestBinding, target.nonce); }
    catch { return failure("ARGUMENT_INVALID", "Complete canonical original owned guest binding required."); }
  }
  let originalOs: Readonly<OwnedGuestOsRelease> | undefined;
  if (target.ownedGuestOsRelease !== undefined) {
    try {
      if (!ownedBinding) throw new Error("Original OS requires full owned custody binding.");
      originalOs = copyOwnedGuestOsRelease(target.ownedGuestOsRelease);
    } catch { return failure("ARGUMENT_INVALID", "Complete canonical original owned OS and custody binding required."); }
  }
  if (target.recordedHelpers !== undefined && (target.recordedHelpers !== true || !ownedBinding)) return failure("ARGUMENT_INVALID", "Recorded helpers require explicit full original owned guest binding.");
  if (!/^[a-f0-9]{64}$/.test(target.qualificationSourceSha256) || !ownedBinding || originalOs?.id !== "debian" || originalOs.versionId !== "13" || !Number.isFinite(target.phaseDeadline) || target.phaseDeadline <= performance.now() || target.phaseDeadline > performance.now() + 900000) return failure("ARGUMENT_INVALID", "Complete current Debian13 custody and original bounded phase deadline required.");
  target = Object.freeze({ ...target, ownedGuestBinding: ownedBinding, ownedGuestOsRelease: originalOs });
  const ownedArguments = ownedBinding ? ` --owned-guest-boot-id ${ownedBinding.bootId} --owned-guest-uid ${ownedBinding.uid} --owned-guest-manifest-sha256 ${ownedBinding.manifestSha256}` : "";
  const recordedArguments = target.recordedHelpers ? " --recorded-helpers" : "";
  if (!Number.isFinite(target.phaseDeadline) || target.phaseDeadline <= performance.now()) return failure("ARGUMENT_INVALID", "Original interruption deadline required.");
  const deadline = Math.min(performance.now() + 900000, target.phaseDeadline);
  const remaining = () => { const value = deadline - performance.now(); if (value <= 0 || signal?.aborted) throw new Error("Guest session aggregate deadline expired or was cancelled"); return Math.ceil(value); };
  // At most one resume connection is possible. Its idle helper owns no SSH.
  const resumeRelay = prepareRetainedSsh(); let connections = 0;
  async function ssh(remote: string): Promise<{ code: number; guest: Record<string, unknown> }> {
    remaining();
    const readyPrefix = `FLEUR_SESSION_READY=${target.nonce}\n`;
    const remoteCommand = `printf 'FLEUR_SESSION_READY=${target.nonce}\\n'; exec ${remote}`;
    const connection = connections++;
    const child = startRetainedSsh(["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remoteCommand], connection === 1 ? resumeRelay : undefined, connection === 0 ? resumeRelay.ready : undefined);
    const finished = child.finished;
    const signalFailed = child.signalFailed;
    const requestTermination = child.requestTermination;
    let startExpired = false; let sessionStarted = false;
    const timeout = Math.max(0, Math.floor(deadline - performance.now()));
    const startTimer = setTimeout(() => { startExpired = true; requestTermination(); }, Math.min(10000, timeout));
    const timer = setTimeout(requestTermination, timeout); signal?.addEventListener("abort", requestTermination, { once: true });
    if (timeout <= 0 || signal?.aborted) requestTermination();
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
    try {
      if (!ownedBinding || !originalOs || target.recordedHelpers !== true) throw new Error("Original full owned binding and recorded input mode required.");
      const observed = await ssh(`python3 -I lab/fleur-interrupted-guest.py ${target.nonce}${ownedArguments}${recordedArguments} --qualification-source ${target.qualificationSourceSha256}`);
      const guest = observed.guest;
      checkRecordedInputs(guest, true);
      checkOriginalOs(guest, ownedBinding, originalOs);
      const interrupted = guest.interruption as Record<string, unknown> | undefined;
      const cli = interrupted?.cli as Record<string, unknown> | undefined;
      const checkpoint = guest.interruptionCheckpointSha256;
      const conformance = guest.interruptionSupervisorConformance as Record<string, unknown> | undefined;
      if (observed.code !== 3 || guest.formatVersion !== 1 || guest.phase !== "reboot-required" || guest.ok !== false || guest.runtimeSupport !== "unverified" || guest.humanConsentProof !== false || guest.error !== undefined
          || interrupted?.kind !== "subreaper-supervised-completed-effects-missing-parent-receipt" || interrupted.historicalOutcome !== "unknown" || interrupted.subreaperDescendantsRetired !== true || cli?.stopped !== true || cli.reapedAfterSigkill !== true
          || conformance?.ok !== true || conformance.runtimeAdmission !== false || conformance.humanConsentProof !== false || typeof checkpoint !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint)) throw new Error("Initial native interruption did not establish its completed-effects checkpoint.");
      return { formatVersion: 1, scope: "interrupted-linux-initial-observation", ok: true, guest };
    } catch (error) { return failure("SESSION_FAILED", error instanceof Error ? error.message : "Native interruption observation failed."); }
  };
  const observed = await observe();
  try { await resumeRelay.close(); }
  catch (error) { return failure("SESSION_FAILED", error instanceof Error ? error.message : "Idle resume relay cleanup is unconfirmed"); }
  return observed;
}
