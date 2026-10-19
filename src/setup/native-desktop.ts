import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostCommandResult, HostIdentity, SetupHost } from "./commands.ts";
import type { DesktopInstallProfile } from "./native.ts";
import { readGrants, stateDirectory, writeGrants, type Grant } from "./grants.ts";
import { SetupBusy, withSetupLock } from "./lock.ts";

function valid(profile: DesktopInstallProfile): boolean {
  const arch = profile.architecture === "x64" ? "amd64" : "arm64";
  return profile.artifactAuthentication === "authenticated" && /^\d+\.\d+\.\d+$/.test(profile.version)
    && /^\d+$/.test(profile.build) && /^[a-f0-9]{64}$/.test(profile.sha256)
    && Number.isSafeInteger(profile.bytes) && profile.bytes > 0 && profile.bytes <= 2 ** 31
    && profile.teamId === "9BNSXJN65R"
    && profile.url === `https://desktop.docker.com/mac/main/${arch}/${profile.build}/Docker.dmg`;
}
class DesktopRecoveryRequired extends Error {}
class DesktopHumanActionRequired extends Error {}
function osPermissionRequired(error: unknown): boolean {
  return ["EACCES", "EPERM", "ENOENT"].includes((error as { code?: string }).code ?? "");
}
function completed(result: HostCommandResult): boolean { return result.status === "completed" && result.exitCode === 0; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid system metadata");
  return value as Record<string, unknown>;
}
function entities(value: unknown): Record<string, unknown>[] {
  const list = object(value)["system-entities"];
  if (!Array.isArray(list)) throw new Error("Missing system entities");
  return list.map(object);
}
async function matchesImage(path: string, profile: DesktopInstallProfile, remaining: () => number): Promise<boolean> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size !== profile.bytes) return false;
    const hash = new Bun.CryptoHasher("sha256");
    const buffer = Buffer.alloc(65536);
    let total = 0;
    while (total <= profile.bytes) {
      if (remaining() <= 5000) throw new Error("Desktop hashing deadline");
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, profile.bytes + 1 - total));
      if (!bytesRead) break;
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return total === profile.bytes && hash.digest("hex") === profile.sha256;
  } finally { await file.close(); }
}
async function removeOwnedDirectory(path: string, identity: { dev: number; ino: number } | undefined): Promise<boolean> {
  try {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity?.dev || current.ino !== identity?.ino) return false;
    await rm(path, { recursive: true });
    return true;
  } catch { return false; }
}
/** Atomic no-replacement publication, anchored to the already opened parent and stage. */
async function publish(stageFd: number, parentFd: number): Promise<void> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw new Error("Unsupported filesystem publication");
  const name = mac ? "renameatx_np" : "renameat2";
  const library = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    [name]: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  try {
    const source = Buffer.from("Docker.app\0");
    const destination = Buffer.from("Docker.app\0");
    if (library.symbols[name]!(stageFd, ptr(source), parentFd, ptr(destination), mac ? 4 : 1) !== 0) throw new Error("Application placement refused");
  } finally { library.close(); }
}

export async function setupNativeDesktop(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: DesktopInstallProfile, remaining: () => number): Promise<CliOutcome> {
  if (!valid(profile) || !identity.machineId || !/^[a-f0-9]{64}$/.test(identity.machineId)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Desktop requires an authenticated exact source-owned artifact profile.", actions: [] });
  const readAuthority = async () => { try { return await readGrants(host); } catch { throw new DesktopRecoveryRequired("Unsafe private authority state"); } };
  const writeAuthority = async (grants: readonly Grant[]) => { try { await writeGrants(host, grants); } catch { throw new DesktopRecoveryRequired("Authority publication was not durable"); } };
  const applications = resolve(host.desktopApplicationsDirectory ?? "/Applications");
  const destination = join(applications, "Docker.app");
  const requiredAuthorities = ["image-acquire", "install"] as const;
  const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify({ profile, applications, actions: requiredAuthorities }), "hex");
  const target = `Docker Desktop ${profile.version} ${profile.architecture} ${profile.sha256} to ${applications}`;
  const plan = { method: profile.method, artifactAuthentication: profile.artifactAuthentication, nativeEvidence: profile.nativeEvidence, requiredAuthorities, checksum };
  const authority = () => failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Desktop acquisition and placement need separate scoped authority. Agreement, launch and configuration remain human actions.", actions: [] }, { plan, resumable: true });
  try {
    try { await lstat(destination); return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "An existing Docker application was preserved. Setup never replaces or repairs it automatically.", actions: [] }); }
    catch (error) { if ((error as { code?: string }).code !== "ENOENT") { if (osPermissionRequired(error)) throw new DesktopHumanActionRequired("Application inspection requires OS access"); throw error; } }
    return await withSetupLock(stateDirectory(host), async () => {
      const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
      const matching = (grant: Grant, action: string) => !grant.revoked && grant.action === action && grant.method === profile.method && grant.target === target && grant.planChecksum === checksum && grant.machine === identity.machineId && grant.user === process.getuid?.() && (action !== "install" || !specified || specified === grant.id);
      if (specified && !(await readAuthority()).some((grant) => matching(grant, "install"))) return authority();
      for (const action of requiredAuthorities) {
        const grants = [...await readAuthority()];
        if (!grants.some((grant) => matching(grant, action))) {
          if (specified || input.json || !host.interactive || !host.confirmHuman) return authority();
          const decision = await host.confirmHuman({ action, method: profile.method, target, checksum }, remaining());
          if (decision !== "once" && decision !== "remembered") return authority();
          grants.push({ id: crypto.randomUUID(), action, method: profile.method, target, planChecksum: checksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false });
          await writeAuthority(grants);
        }
      }
      // Placement uses the invoking user's existing filesystem authority. No sudo/helper/configuration is implicit.
      const parent = await open(applications, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error: unknown) => { if (osPermissionRequired(error)) throw new DesktopHumanActionRequired("Application directory requires OS access"); throw error; });
      let temporary: string | undefined;
      let stage: string | undefined;
      let stageIdentity: { dev: number; ino: number } | undefined;
      let temporaryIdentity: { dev: number; ino: number } | undefined;
      let attached = false;
      let attachedDisk: string | undefined;
      let cleanup = true;
      let installed = false;
      let published = false;
      let publicationUncertain = false;
      let preserveStage = false;
      let copyCompleted = false;
      let copiedAppIdentity: { dev: number; ino: number } | undefined;
      const installationState = () => publicationUncertain ? "uncertain" : installed ? "completed" : "incomplete";
      const sameApp = async () => {
        try {
          const current = await lstat(join(stage!, "Docker.app"));
          return current.isDirectory() && !current.isSymbolicLink() && current.dev === copiedAppIdentity?.dev && current.ino === copiedAppIdentity?.ino;
        } catch { return false; }
      };
      const stageContentsOwned = async () => {
        try {
          const entries = await readdir(stage!);
          if (published || entries.length === 0) return entries.length === 0;
          if (!copyCompleted || !copiedAppIdentity) return false;
          if (entries.some((entry) => entry !== "Docker.app")) return false;
          return await sameApp();
        } catch { return false; }
      };
      let authenticating = false;
      let outcome: CliOutcome | undefined;
      try {
        const parentInfo = await parent.stat();
        const parentMatches = async () => { const current = await lstat(applications); return current.isDirectory() && !current.isSymbolicLink() && current.dev === parentInfo.dev && current.ino === parentInfo.ino; };
        if (!await parentMatches()) throw new Error("Application directory changed");
        try { await access(applications, constants.W_OK); } catch (error) { if (osPermissionRequired(error)) throw new DesktopHumanActionRequired("Application placement requires OS access"); throw error; }
        let grants = [...await readAuthority()];
        const covered = requiredAuthorities.map((action) => grants.find((grant) => matching(grant, action)));
        if (covered.some((grant) => !grant)) return authority();
        const once = new Set(covered.filter((grant) => grant?.mode === "once").map((grant) => grant!.id));
        grants = grants.map((grant) => once.has(grant.id) ? { ...grant, revoked: true } : grant);
        await writeAuthority(grants);
        const run = async (args: readonly string[], reserve = 5000) => {
          const budget = Math.max(0, remaining() - reserve);
          if (!budget) throw new Error("Desktop operation deadline");
          const result = await host.run(args, budget);
          if (!completed(result)) throw new Error("Desktop system operation failed");
          return result;
        };
        authenticating = true;
        temporary = await realpath(await mkdtemp(join(tmpdir(), "fleur-desktop-")));
        temporaryIdentity = await lstat(temporary);
        const image = join(temporary, "Docker.dmg");
        const mount = join(temporary, "mounted");
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(mount, { mode: 0o700 });
        await run(["curl", "--fail", "--proto", "=https", "--tlsv1.2", "--max-redirs", "0", "--max-filesize", String(profile.bytes), "--output", image, profile.url]);
        if (!await matchesImage(image, profile, remaining)) throw new Error("Desktop image integrity mismatch");
        const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${profile.teamId}"`;
        await run(["codesign", "--verify", "--strict", "--test-requirement", requirement, image]);
        const notarized = await run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", image]);
        if (!`${notarized.stdout}\n${notarized.stderr}`.includes("source=Notarized Developer ID")) throw new Error("Desktop image notarization unverified");
        const metadata = async (text: string, name: string, reserve = 5000): Promise<unknown> => {
          const path = join(temporary!, `${name}.plist`);
          await writeFile(path, text, { flag: "wx", mode: 0o600 });
          return JSON.parse((await run(["plutil", "-convert", "json", "-o", "-", path], reserve)).stdout) as unknown;
        };
        const detachOwnedImage = async (): Promise<boolean> => {
          try {
              const live = object(await metadata((await run(["hdiutil", "info", "-plist"], 0)).stdout, "live", 0));
              if (!Array.isArray(live.images)) throw new Error("Missing image inventory");
              const images = live.images.map(object).filter((entry) => entry["image-path"] === image);
              if (images.length !== 1) throw new Error("Owned mounted image identity unknown");
              const parts = entities(images[0]);
              const disks = parts.filter((part) => part["content-hint"] === "GUID_partition_scheme" && typeof part["dev-entry"] === "string" && /^\/dev\/disk\d+$/.test(part["dev-entry"]));
              if (disks.length !== 1 || parts.filter((part) => part["mount-point"] === mount).length !== 1) throw new Error("Owned mounted image identity changed");
              if (attachedDisk && disks[0]!["dev-entry"] !== attachedDisk) throw new Error("Owned image device identity changed");
              await run(["hdiutil", "detach", String(disks[0]!["dev-entry"])], 0);
              return true;
          } catch { return false; }
        };
        try {
          // A failed/timed-out attach may still have mounted; inspect exact owned identity during finally.
          attached = true;
          const attachment = await run(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-plist", "-mountpoint", mount, image]);
          const parts = entities(await metadata(attachment.stdout, "attach"));
          const disks = parts.filter((part) => part["content-hint"] === "GUID_partition_scheme" && typeof part["dev-entry"] === "string" && /^\/dev\/disk\d+$/.test(part["dev-entry"]));
          if (disks.length !== 1 || parts.filter((part) => part["mount-point"] === mount).length !== 1) throw new Error("Desktop attachment identity unknown");
          attachedDisk = String(disks[0]!["dev-entry"]);
          const app = join(mount, "Docker.app");
          const appInfo = await lstat(app);
          if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw new Error("Desktop application is not a directory");
          await run(["codesign", "--verify", "--deep", "--strict", "--test-requirement", `${requirement} and identifier "com.docker.docker"`, app]);
          const appNotarized = await run(["spctl", "--assess", "--type", "execute", "--verbose=4", app]);
          if (!`${appNotarized.stdout}\n${appNotarized.stderr}`.includes("source=Notarized Developer ID")) throw new Error("Desktop application notarization unverified");
          if ((await run(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", join(app, "Contents", "Info.plist")])).stdout.trim() !== profile.version) throw new Error("Desktop version mismatch");
          if ((await run(["lipo", "-archs", join(app, "Contents", "MacOS", "com.docker.backend")])).stdout.trim() !== (profile.architecture === "x64" ? "x86_64" : "arm64")) throw new Error("Desktop architecture mismatch");
          if (!await parentMatches()) throw new Error("Application directory changed");
          authenticating = false;
          stage = await mkdtemp(join(applications, ".fleur-desktop-"));
          stageIdentity = await lstat(stage);
          const stageHandle = await open(stage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            const openedStage = await stageHandle.stat();
            if (!openedStage.isDirectory() || openedStage.dev !== stageIdentity.dev || openedStage.ino !== stageIdentity.ino) { preserveStage = true; throw new Error("Stage descriptor identity changed"); }
            await run(["ditto", app, join(stage, "Docker.app")]);
            copyCompleted = true;
            const copied = await lstat(join(stage, "Docker.app"));
            copiedAppIdentity = copied;
            if (!copied.isDirectory() || copied.isSymbolicLink() || !await parentMatches()) throw new Error("Application staging changed");
            await run(["codesign", "--verify", "--deep", "--strict", "--test-requirement", `${requirement} and identifier "com.docker.docker"`, join(stage, "Docker.app")]);
            const currentStage = await lstat(stage);
            if (!currentStage.isDirectory() || currentStage.isSymbolicLink() || currentStage.dev !== stageIdentity.dev || currentStage.ino !== stageIdentity.ino || !await parentMatches()) throw new Error("Application staging identity changed");
            if (!await sameApp() || !await stageContentsOwned()) { preserveStage = true; throw new Error("Staged application identity changed"); }
            await publish(stageHandle.fd, parent.fd);
            published = true;
            publicationUncertain = true;
            const placed = await lstat(destination);
            if (!await parentMatches() || placed.dev !== copied.dev || placed.ino !== copied.ino) throw new Error("Application publication identity changed");
            await parent.sync();
            installed = true;
            publicationUncertain = false;
          } finally { await stageHandle.close(); }
        } finally {
          if (attached) { cleanup = await detachOwnedImage(); attached = !cleanup; }
        }
      } catch (error) {
        const recovery = publicationUncertain || error instanceof DesktopRecoveryRequired;
        outcome = failure("setup", recovery ? 5 : authenticating ? 4 : 3, { code: recovery ? "RECOVERY_REQUIRED" : authenticating ? "PREREQUISITE_UNAVAILABLE" : "HUMAN_ACTION_REQUIRED", message: "Desktop authentication or placement did not finish. Existing applications were preserved; inspect prerequisites before retrying.", actions: [] }, { setupAction: { action: "install", state: installationState() }, nativeSupport: "unverified", resumable: true });
      } finally {
        await parent.close();
        if (stage && (preserveStage || !await stageContentsOwned() || !await removeOwnedDirectory(stage, stageIdentity))) cleanup = false;
        if (temporary && !attached && !await removeOwnedDirectory(temporary, temporaryIdentity)) cleanup = false;
      }
      if (!cleanup) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "The owned Desktop image or staging directory could not be cleaned up safely. No force or unrelated cleanup was attempted.", actions: [] }, { cleanup: false, setupAction: { action: "install", state: installationState() }, nativeSupport: "unverified", resumable: true });
      return outcome ? { ...outcome, result: { ...outcome.result, data: { cleanup: true, setupAction: { action: "install", state: installationState() }, nativeSupport: "unverified", resumable: true } } } : failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "Docker Desktop was placed without launching it. Complete its agreement and any separately authorized configuration/start actions, then rerun doctor.", actions: [{ command: "fleur doctor", description: "Verify actual local daemon and smoke readiness after completing human setup." }] }, { setupAction: { action: "install", state: "completed" }, cleanup: true, nativeSupport: "unverified", resumable: true });
    }, host.syncDirectory);
  } catch (error) { return failure("setup", error instanceof DesktopHumanActionRequired ? 3 : 5, { code: error instanceof SetupBusy ? "MAINTENANCE_BUSY" : error instanceof DesktopHumanActionRequired ? "HUMAN_ACTION_REQUIRED" : "RECOVERY_REQUIRED", message: "Desktop setup requires safe private authority state and an existing writable application directory; no privileged copy was attempted.", actions: [] }); }
}
