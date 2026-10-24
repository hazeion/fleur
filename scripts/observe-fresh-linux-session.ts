import recordedOrigin from "../experiments/compatibility/runtime-probe/recorded-helper-origin.json";
import { copyOwnedGuestBinding, copyOwnedGuestOsRelease, type OwnedGuestBinding, type OwnedGuestOsRelease } from "./owned-guest-seed.ts";
import { isDeepStrictEqual } from "node:util";
import { prepareRetainedSsh, startRetainedSsh } from "./retained-ssh.ts";
import type { Readable } from "node:stream";
export interface SessionTarget { port: number; identity: string; knownHosts: string; nonce: string; ownedGuestBinding?: OwnedGuestBinding; ownedGuestOsRelease?: OwnedGuestOsRelease; recordedHelpers?: true }
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
function checkRecordedInputs(guest: Record<string, unknown>, selected: boolean): void {
  if (!selected) {
    if (guest.helperMode !== undefined || guest.recordedHelperInputs !== undefined) throw new Error("Unexpected recorded helper input binding");
    return;
  }
  const inputs = guest.recordedHelperInputs as { manifestSha256?: unknown; files?: Record<string, { size?: unknown; sha256?: unknown; identity?: unknown }>; directoryIdentity?: unknown } | undefined;
  const identity = (value: unknown) => Array.isArray(value) && value.length === 8 && value.every((part) => typeof part === "string" && /^(0|[1-9][0-9]{0,23})$/.test(part));
  if (guest.helperMode !== "recorded-prebuilt" || !inputs || inputs.manifestSha256 !== "26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b"
      || !identity(inputs.directoryIdentity) || !inputs.files || !isDeepStrictEqual(Object.keys(inputs.files).sort(), ["abuse", "filter.so"])
      || !recordedOrigin.helpers.every((pin) => inputs.files?.[pin.name]?.size === pin.bytes && inputs.files[pin.name]?.sha256 === pin.sha256 && identity(inputs.files[pin.name]?.identity))) throw new Error("Guest recorded helper input binding is incomplete or differs");
}
function checkRecordedTerminal(guest: Record<string, unknown>, binding: Readonly<OwnedGuestBinding>): void {
  if (guest.ok !== true) return;
  const proof = (guest.restrictionProbe as { result?: Record<string, unknown> } | undefined)?.result;
  const custody = proof?.owned_host_control as Record<string, unknown> | undefined;
  const context = proof?.helper_artifact_context as Record<string, unknown> | undefined;
  const expectedOrigin = { mode: "recorded-prebuilt", manifest_sha256: "26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b", architecture: recordedOrigin.architecture, base_image: recordedOrigin.baseImage, local_compiler_executed: false, producer: recordedOrigin.producer, source_sha256: Object.fromEntries(recordedOrigin.sources.map((item) => [item.file, item.sha256])), helpers: recordedOrigin.helpers };
  const elf = { class: 64, endianness: "little", machine: 62 };
  if (!proof || proof.compiler_status !== "prebuilt-origin" || proof.compiler_pin_verified !== false || "gcc" in proof
      || proof.expected_gcc !== recordedOrigin.producer.compiler.version || proof.expected_gcc_binary_sha256 !== recordedOrigin.producer.compiler.sha256
      || proof.architecture !== recordedOrigin.architecture || proof.base_image !== recordedOrigin.baseImage || !isDeepStrictEqual(proof.helper_origin, expectedOrigin)
      || !recordedOrigin.sources.every((item) => (proof.source_sha256 as Record<string, unknown> | undefined)?.[item.file] === item.sha256)
      || proof.helper_sha256 !== recordedOrigin.helpers[0]!.sha256 || proof.abuse_sha256 !== recordedOrigin.helpers[1]!.sha256
      || !isDeepStrictEqual(proof.helper_elf, elf) || !isDeepStrictEqual(proof.abuse_elf, elf)
      || proof.helper_origin_verified !== true || proof.owned_artifact_disposal_scope_verified !== true
      || !custody || !Object.entries(binding).every(([key, value]) => custody[key] === value) || custody.fixtureCustodyValidated !== true || custody.hostControlScope !== "owned-guest" || custody.runtimeAdmission !== false
      || context?.state !== "retained-for-owned-guest-disposal" || context.disposal_scope !== "owned-full-system-guest-filesystem" || context.local_disposal !== "pending"
      || context.cleanup_confirmed !== false || context.retained !== true || context.ledger_verified !== true) throw new Error("Guest recorded helper origin or owned disposal scope differs");
}
const ordinaryQualifications = {
  "ubuntu:24.04": { profile: "ubuntu-24.04-x64-docker-29.9.1", evidence: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2" },
  "ubuntu:26.04": { profile: "ubuntu-26.04-x64-docker-29.9.1", evidence: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07" },
  "debian:13": { profile: "debian-13-x64-docker-29.9.1", evidence: "6b4066ed5c199006695d769d07ec5d813fa8cddff1d396a089e1749d6c27231e" },
} as const;
function checkOriginalOs(guest: Record<string, unknown>, binding?: Readonly<OwnedGuestBinding>, original?: Readonly<OwnedGuestOsRelease>): void {
  const custody = guest.ownedGuestCustody as Record<string, unknown> | undefined;
  if (!original) {
    if (custody?.osRelease !== undefined && copyOwnedGuestOsRelease(custody.osRelease).versionId !== "24.04") throw new Error("Ubuntu 26 requires the original owned OS binding; legacy proof is Ubuntu 24 only.");
    return;
  }
  if (!binding || !custody || !Object.entries(binding).every(([key, value]) => custody[key] === value)
      || !isDeepStrictEqual(custody.osRelease, original) || custody.formatVersion !== 1 || custody.scope !== "owned-guest-custody-validation"
      || custody.ok !== true || custody.fixtureCustodyValidated !== true || custody.runtimeSupport !== "unverified" || custody.runtimeAdmission !== false
      || custody.humanConsentProof !== false || custody.nativeCpuPerformanceProof !== false) throw new Error("Guest custody or OS differs from the original owned binding.");
}
function checkTerminalProof(code: number, guest: Record<string, unknown>, originalOs?: Readonly<OwnedGuestOsRelease>): void {
  if (typeof guest.ok !== "boolean" || (code === 0) !== guest.ok) throw new Error("Guest final proof contradicts its exit status");
  if (!guest.ok) return;
  const restriction = guest.restrictionProbe as { exitCode?: unknown; result?: { bounded_probe_passed?: unknown; cleanup_complete?: unknown } } | undefined;
  if (guest.installationEvidence !== "verified-full-system-guest" || !guest.baseline || !Array.isArray(guest.runs) || guest.runs.length !== 2 || guest.sentinelCleanup !== true || restriction?.exitCode !== 0 || restriction.result?.bounded_probe_passed !== true || restriction.result.cleanup_complete !== true) throw new Error("Guest final proof is incomplete");
  for (const item of guest.runs) {
    const observed = item as { exitCode?: unknown; result?: { formatVersion?: unknown; command?: unknown; ok?: unknown; truncated?: unknown; error?: { code?: unknown }; data?: { components?: Record<string, { state?: unknown; cleanup?: unknown }> } } };
    const envelope = observed?.result; const components = envelope?.data?.components;
    const artifact = guest.executionArtifact as { kind?: unknown; packageName?: unknown } | undefined;
    if (artifact?.kind === "ordinary") {
      const key = originalOs ? `${originalOs.id}:${originalOs.versionId}` : "ubuntu:24.04";
      if (!Object.hasOwn(ordinaryQualifications, key)) throw new Error("Ordinary qualification is unavailable for this guest distribution.");
      const { profile, evidence } = ordinaryQualifications[key as keyof typeof ordinaryQualifications];
      if (artifact.packageName !== "fleur" || observed?.exitCode !== 0 || envelope?.formatVersion !== 1 || envelope.command !== "doctor" || envelope.ok !== true || envelope.error !== null || envelope.truncated !== false
          || !isDeepStrictEqual(Object.keys(envelope).sort(), ["formatVersion", "command", "ok", "data", "error", "truncated"].sort())
          || !["cli", "daemon", "compose", "smoke"].every((name) => components?.[name]?.state === "ready") || components?.smoke?.cleanup !== true
          || !isDeepStrictEqual(components?.release, { state: "verified", profile, evidence: { readinessSha256: evidence, isolationSha256: evidence } })) throw new Error("Guest final proof lacks exact admitted ordinary doctor rounds");
      continue;
    }
    if (observed?.exitCode !== 4 || envelope?.formatVersion !== 1 || envelope.command !== "doctor" || envelope.ok !== false || envelope.truncated !== false || envelope.error?.code !== "PREREQUISITE_UNAVAILABLE"
        || !["cli", "daemon", "compose", "smoke"].every((name) => components?.[name]?.state === "ready") || components?.smoke?.cleanup !== true || components?.release?.state !== "unverified") throw new Error("Guest final proof lacks the complete release-unverified doctor rounds");
  }
}
/** Own the guest workflow transport; artifact authentication remains the caller's gate. */
export async function observeGuestSessions(target: SessionTarget, signal?: AbortSignal): Promise<SessionObservation> {
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
  target = Object.freeze({ ...target, ownedGuestBinding: ownedBinding, ownedGuestOsRelease: originalOs });
  const ownedArguments = ownedBinding ? ` --owned-guest-boot-id ${ownedBinding.bootId} --owned-guest-uid ${ownedBinding.uid} --owned-guest-manifest-sha256 ${ownedBinding.manifestSha256}` : "";
  const recordedArguments = target.recordedHelpers ? " --recorded-helpers" : "";
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
      const observed = await ssh(`python3 lab/fresh-linux-guest.py ${target.nonce}${ownedArguments}${recordedArguments}`);
      const guest = observed.guest; initialGuest = guest;
      checkRecordedInputs(guest, target.recordedHelpers === true);
      if (guest.formatVersion !== 1 || guest.runtimeSupport !== "unverified" || guest.humanConsentProof !== false) throw new Error("Guest metadata differs from its declared scope");
      checkOriginalOs(guest, ownedBinding, originalOs);
      if (observed.code === 3 || guest.phase !== undefined) {
        const checkpoint = guest.checkpoint as { sha256?: unknown; bytes?: unknown } | undefined;
        const handoff = guest.accessHandoff as { after?: { user?: { name?: unknown; uid?: unknown }; group?: { gid?: unknown }; accountGroups?: unknown; sessionGroups?: unknown } } | undefined;
        const after = handoff?.after;
        if (observed.code !== 3 || guest.phase !== "new-login-required" || guest.ok !== false || guest.installationEvidence !== "pending" || !guest.baseline || !checkpoint || typeof checkpoint.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.sha256)
            || typeof checkpoint.bytes !== "number" || !Number.isSafeInteger(checkpoint.bytes) || checkpoint.bytes <= 0 || checkpoint.bytes > 2 * 1024 * 1024 - 65536
            || after?.user?.name !== "fleur" || typeof after.user.uid !== "number" || !Number.isSafeInteger(after.user.uid) || after.user.uid <= 0 || typeof after.group?.gid !== "number"
            || !numericGroups(after.accountGroups) || !numericGroups(after.sessionGroups) || !after.accountGroups.includes(after.group.gid) || after.sessionGroups.includes(after.group.gid)) throw new Error("Intermediate guest handoff is invalid");
        const expectedGroups = after.accountGroups;
        const resumed = await ssh(`python3 lab/fresh-linux-guest.py ${target.nonce} --resume ${checkpoint.sha256}${ownedArguments}${recordedArguments}`);
        const final = resumed.guest;
        checkRecordedInputs(final, target.recordedHelpers === true);
        checkOriginalOs(final, ownedBinding, originalOs);
        if (target.recordedHelpers && !isDeepStrictEqual(final.recordedHelperInputs, guest.recordedHelperInputs)) throw new Error("Resumed recorded helper input binding changed");
        const access = final.accessResume as { checkpointSha256?: unknown; sessionGroups?: unknown } | undefined;
        if (resumed.code === 3 || final.phase !== undefined || final.formatVersion !== 1 || final.runtimeSupport !== "unverified" || final.humanConsentProof !== false || !isDeepStrictEqual(final.baseline, guest.baseline)
            || access?.checkpointSha256 !== checkpoint.sha256 || !numericGroups(access.sessionGroups) || access.sessionGroups.length !== expectedGroups.length || !access.sessionGroups.every((gid) => expectedGroups.includes(gid))) throw new Error("Resumed ordinary login report differs from its anchored handoff");
        if (target.recordedHelpers) checkRecordedTerminal(final, ownedBinding!);
        checkTerminalProof(resumed.code, final, originalOs);
        return { formatVersion: 1, scope: "fresh-linux-session-observation", ok: resumed.code === 0 && final.ok === true, initialGuest: guest, guest: final };
      }
      if (target.recordedHelpers) checkRecordedTerminal(guest, ownedBinding!);
      checkTerminalProof(observed.code, guest, originalOs);
      return { formatVersion: 1, scope: "fresh-linux-session-observation", ok: observed.code === 0 && guest.ok === true, guest };
    } catch (error) { return { ...failure("SESSION_FAILED", error instanceof Error ? error.message : "Guest session failed"), ...(initialGuest ? { initialGuest } : {}) }; }
  };
  const observed = await observe();
  try { await resumeRelay.close(); }
  catch (error) { return failure("SESSION_FAILED", error instanceof Error ? error.message : "Idle resume relay cleanup is unconfirmed"); }
  return observed;
}
export { checkRecordedInputs, checkRecordedTerminal, checkOriginalOs, checkTerminalProof, numericGroups };

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
