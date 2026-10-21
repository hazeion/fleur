import { setupLinuxAccess } from "./linux-access.ts";
import { setupArchService, archServicePolicy } from "./arch-service.ts";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readGrants, stateDirectory, writeGrants, type Grant } from "./grants.ts";
import { withSetupLock, SetupBusy, syncStateDirectory } from "./lock.ts";
import type { CommandInput } from "../cli/catalog.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";

export interface ArchPackageArtifact {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly signature: string;
  readonly signer: string;
}
/** Release-owned exact artifacts; no CLI/project/environment can provide a profile. */
export interface ArchInstallProfile {
  readonly method: "arch-official-pacman";
  readonly verified: true;
  readonly distribution: "arch";
  readonly release: "rolling";
  readonly architecture: "x64";
  readonly snapshot: "2026-10-12";
  readonly packages: Readonly<Record<"docker" | "docker-compose" | "containerd" | "runc", ArchPackageArtifact>>;
}

const names = ["containerd", "docker", "docker-compose", "runc"] as const;
const strongerPolicy = "\n[options]\nLocalFileSigLevel = Required TrustedOnly\n";
function validProfile(profile: ArchInstallProfile): boolean {
  return profile.verified === true && profile.distribution === "arch" && profile.release === "rolling" && profile.architecture === "x64" && profile.snapshot === "2026-10-12" && Object.keys(profile.packages).length === names.length && names.every((name) => {
    const artifact = profile.packages[name];
    return artifact && typeof artifact.version === "string" && typeof artifact.url === "string" && typeof artifact.sha256 === "string" && typeof artifact.signer === "string" && typeof artifact.signature === "string" && /^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(artifact.version)
      && artifact.url === `https://archive.archlinux.org/packages/${name[0]}/${name}/${name}-${artifact.version}-x86_64.pkg.tar.zst`
      && /^[a-f0-9]{64}$/.test(artifact.sha256) && /^[A-F0-9]{40}$/.test(artifact.signer)
      && Number.isSafeInteger(artifact.size) && artifact.size > 0 && artifact.size <= 134217728
      && /^[A-Za-z0-9+/]+={0,2}$/.test(artifact.signature) && artifact.signature.length <= 65536;
  }) && Object.values(profile.packages).reduce((total, artifact) => total + artifact.size, 0) <= 268435456;
}

export async function setupNativeArch(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: ArchInstallProfile, remaining: () => number, existingCli = false, endpoint?: string, daemonReady = false, daemonDenied = false): Promise<CliOutcome> {
  const unavailable = (message: string) => failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message, actions: [] });
  if (!validProfile(profile) || !identity.machineId || !/^[a-f0-9]{64}$/.test(identity.machineId)) return unavailable("The exact Arch artifact profile or machine identity is unavailable.");
  const run = (args: readonly string[]) => remaining() > 0 ? host.run(args, remaining()) : Promise.resolve({ status: "timeout" as const, stdout: "", stderr: "" });
  const inventory = async () => {
    const queried = await run(["pacman", "--query", "--", ...names]);
    if (queried.status !== "completed" || ![0, 1].includes(queried.exitCode ?? -1)) return null;
    const present: string[] = [];
    for (const line of queried.stdout.split("\n").filter(Boolean)) {
      const row = /^([a-z0-9-]+) ([^ ]+)$/.exec(line);
      const name = row?.[1];
      if (!name || !names.includes(name as typeof names[number]) || present.includes(name) || profile.packages[name as typeof names[number]].version !== row?.[2]) return null;
      present.push(name);
    }
    if (queried.exitCode === 0 && present.length !== names.length) return null;
    if (queried.stderr.trim() && queried.stderr.trim().split("\n").some((line) => !/^error: package '[a-z0-9-]+' was not found$/.test(line))) return null;
    return { present: present.sort(), missing: names.filter((name) => !present.includes(name)) };
  };
  try {
    return await withSetupLock(stateDirectory(host), async () => {
      const actual = await inventory();
      if (!actual || (existingCli && !actual.present.includes("docker"))) return unavailable("Existing or indeterminate Arch packages/CLI were preserved; setup never upgrades or replaces conflicting tools.");
      const lock = await run(["stat", "--format=%F|%u|%a|%h", "--", "/var/lib/pacman/db.lck"]);
      if (lock.status !== "completed" || lock.exitCode !== 1 || !/No such file or directory/.test(lock.stderr)) return failure("setup", 5, { code: "MAINTENANCE_BUSY", message: "Pacman is busy or its database lock state is indeterminate; no lock was removed.", actions: [] });
      const consistent = await run(["pacman", "--database", "--check", "--quiet"]);
      if (consistent.status !== "completed" || consistent.exitCode !== 0) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "The existing package database requires human recovery; no repair was attempted.", actions: [] });
      const pendingPath = join(stateDirectory(host), "arch-transaction-pending.json");
      try { await lstat(pendingPath); return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "An earlier privileged Arch transaction has no confirmed terminal result. Preserve its private data and inspect actual package state before recovery.", actions: [] }); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      if (actual.missing.length === 0 && daemonDenied && endpoint) return setupLinuxAccess(input, host, identity, archServicePolicy(profile), remaining, endpoint);
      if (actual.missing.length === 0 && daemonReady) return unavailable("The existing daemon is usable; no system service action was attempted. Native runtime support remains unverified.");
      if (actual.missing.length === 0) return setupArchService(input, host, identity, profile, remaining, endpoint);
      const requiredAuthorities = ["install", "configuration", "docker-access"] as const;
      if (input.json && !(await readGrants(host)).some((grant) => !grant.revoked && grant.method === profile.method)) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "The exact Arch installation and its configuration/access-group effects require separate human permissions.", actions: [{ command: "fleur setup", description: "Inspect the bounded official Arch package plan." }] }, { plan: { method: profile.method, requiredAuthorities }, resumable: true });
      const backend = await run(["pacman", "--version"]);
      if (backend.status !== "completed" || backend.exitCode !== 0 || !/\bPacman v7\.1\.0 - libalpm v16\.0\.0[ \t]*$/m.test(backend.stdout)) return unavailable("This exact pacman/backend question policy has not been reviewed for the installed version.");
      const metadata = await run(["stat", "--format=%F|%u|%a|%h", "--", "/etc/pacman.conf"]);
      const resolved = await run(["pacman-conf"]);
      if (metadata.status !== "completed" || metadata.exitCode !== 0 || !/^regular file\|0\|(?:644|444)\|1\s*$/.test(metadata.stdout) || resolved.status !== "completed" || resolved.exitCode !== 0 || !resolved.stdout.trim() || resolved.stdout.length > 32768) return unavailable("The root-owned pacman configuration cannot be safely resolved; it was preserved.");
      const optionRows: string[] = [];
      let inOptions = false;
      for (const line of resolved.stdout.split("\n")) {
        if (line.startsWith("[")) inOptions = line === "[options]";
        if (inOptions) optionRows.push(line);
      }
      if (!optionRows.length || optionRows.some((line) => /^Include\s*=/.test(line))) return unavailable("Pacman's effective options cannot be frozen without unresolved includes.");
      const configuration = optionRows.join("\n") + strongerPolicy;
      const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify({ formatVersion: 1, profile, configuration, effects: { install: "exact-missing-profile-archives", configuration: "distribution-package-configuration-hooks", "docker-access": "system-group-only" }, transaction: { pacman: "7.1.0", libalpm: "16.0.0", questionMask: 75, signaturePolicy: "Required TrustedOnly", guardVersion: 1, services: "unchanged", membership: "unchanged" } }), "hex");
      const target = `Docker Arch x64 snapshot ${profile.snapshot} plan ${checksum}`;
      const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
      const matches = (grant: Grant, action: string) => !grant.revoked && grant.action === action && (action !== "install" || !specified || grant.id === specified) && grant.method === profile.method && grant.target === target && grant.planChecksum === checksum && grant.machine === identity.machineId && grant.user === process.getuid?.();
      for (const action of requiredAuthorities) {
        const grants = [...await readGrants(host)];
        let grant = grants.find((candidate) => matches(candidate, action));
        if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
          const decision = await host.confirmHuman({ action, method: profile.method, target, checksum }, remaining());
          if (decision === "once" || decision === "remembered") {
            grant = { id: crypto.randomUUID(), action, method: profile.method, target, planChecksum: checksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false };
            grants.push(grant); await writeGrants(host, grants);
          }
        }
        if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Each Arch installation/configuration/access-group effect needs its own exact matching grant.", actions: [] }, { plan: { method: profile.method, requiredAuthorities, checksum, target }, resumable: true });
      }
      const staging = await mkdtemp(join(stateDirectory(host), "arch-"));
      let retain = false;
      try {
        const configPath = join(staging, "pacman.conf");
        await writeFile(configPath, configuration, { flag: "wx", mode: 0o600 });
        for (const [directive, expected] of Object.entries({ RootDir: "/", DBPath: "/var/lib/pacman/", GPGDir: "/etc/pacman.d/gnupg/", HookDir: "/etc/pacman.d/hooks/" })) {
          const before = await run(["pacman-conf", directive]);
          const after = await run(["pacman-conf", "--config", configPath, directive]);
          if (before.status !== "completed" || before.exitCode !== 0 || before.stdout.trim() !== expected || after.status !== "completed" || after.exitCode !== 0 || after.stdout !== before.stdout) return unavailable("The private signature policy would change the expected package root/database/keyring/hooks; existing configuration was preserved.");
        }
        const policy = await run(["pacman-conf", "--config", configPath, "LocalFileSigLevel"]);
        if (policy.status !== "completed" || policy.exitCode !== 0 || JSON.stringify(policy.stdout.trim().split(/\s+/).sort()) !== JSON.stringify(["PackageRequired", "PackageTrustedOnly"])) return unavailable("Mandatory trusted local-package signatures could not be established.");
        const customHooks = await run(["ls", "-A", "--", "/etc/pacman.d/hooks/"]);
        if (customHooks.status !== "completed" || customHooks.exitCode !== 0 || customHooks.stdout.trim()) return unavailable("Custom package transaction hooks require a separately reviewed plan; no hooks were changed.");
        const payloads: string[] = [];
        for (const name of actual.missing) {
          const artifact = profile.packages[name];
          const path = join(staging, new URL(artifact.url).pathname.split("/").at(-1)!);
          const downloaded = await run(["curl", "--fail", "--silent", "--show-error", "--proto", "=https", "--max-time", String(Math.max(0.001, remaining() / 1000)), "--max-filesize", String(artifact.size), "--output", path, artifact.url]);
          if (downloaded.status !== "completed" || downloaded.exitCode !== 0) return unavailable("An exact Arch archive download did not complete; no packages were changed.");
          const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const info = await file.stat();
            if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || info.size !== artifact.size) return unavailable("The downloaded Arch archive has unsafe metadata or the wrong size.");
            const content = await file.readFile();
            if (Bun.CryptoHasher.hash("sha256", content, "hex") !== artifact.sha256) return unavailable("The downloaded Arch archive does not match its authenticated digest.");
          } finally { await file.close(); }
          const signaturePath = path + ".sig";
          await writeFile(signaturePath, Buffer.from(artifact.signature, "base64"), { flag: "wx", mode: 0o600 });
          const signed = await run(["sudo", "-n", "gpg", "--no-options", "--homedir", "/etc/pacman.d/gnupg", "--batch", "--no-auto-check-trustdb", "--no-auto-key-retrieve", "--auto-key-locate", "clear", "--status-fd", "1", "--verify", signaturePath, path]);
          const valid = signed.stdout.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
          if (signed.status !== "completed" || signed.exitCode !== 0 || valid.length !== 1 || valid[0]!.split(" ")[2] !== artifact.signer || !/^\[GNUPG:\] TRUST_(?:FULLY|ULTIMATE) /m.test(signed.stdout) || /^\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY) /m.test(signed.stdout)) return unavailable("The exact archive signature/signer is invalid, expired, revoked or untrusted in the current keyring.");
          payloads.push(path);
        }
        // Pacman 7.1.0 inverts selected default-yes ALPM questions with --ask.
        // 75 denies IgnorePkg, Replace, CorruptDelete and ImportKey. Existing default-no
        // conflict/removal decisions remain no; no sync repositories admit providers.
        const simulated = await run(["pacman", "--config", configPath, "--ask", "75", "--upgrade", "--print", "--print-format", "%n\t%v\t%a", "--", ...payloads]);
        const expected = actual.missing.map((name) => `${name}\t${profile.packages[name].version}\tx86_64`).sort();
        if (simulated.status !== "completed" || simulated.exitCode !== 0 || JSON.stringify(simulated.stdout.trim().split("\n").sort()) !== JSON.stringify(expected)) return unavailable("The package plan needs changes outside the exact missing artifact set; dependencies/conflicts require human review.");
        const fresh = await inventory();
        if (JSON.stringify(fresh) !== JSON.stringify(actual)) return unavailable("Package state changed while preparing the transaction; no packages were changed.");
        const hookDirectory = join(staging, "hooks");
        await mkdir(hookDirectory, { mode: 0o700 });
        const guardPlan = JSON.stringify({ formatVersion: 1, user: process.getuid!(), packages: Object.fromEntries(names.map((name) => [name, profile.packages[name].version])), missing: actual.missing });
        const planPath = join(staging, "arch-plan.json");
        await writeFile(planPath, guardPlan, { flag: "wx", mode: 0o600 });
        const guardChecksum = Bun.CryptoHasher.hash("sha256", guardPlan, "hex");
        const quote = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
        const executable = fileURLToPath(new URL("./arch-pre-transaction.ts", import.meta.url));
        const hook = `[Trigger]\nOperation = Install\nOperation = Upgrade\nOperation = Remove\nType = Package\nTarget = *\n[Action]\nWhen = PreTransaction\nExec = ${[process.execPath, executable, planPath, guardChecksum].map(quote).join(" ")}\nAbortOnFail\nNeedsTargets\n`;
        await writeFile(join(hookDirectory, "00-fleur-preserve-existing.hook"), hook, { flag: "wx", mode: 0o600 });
        const grants = [...await readGrants(host)];
        const covered = requiredAuthorities.map((action) => grants.find((grant) => matches(grant, action)));
        if (covered.some((grant) => !grant)) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Arch installation authority changed before the transaction.", actions: [] });
        const once = new Set(covered.filter((grant) => grant?.mode === "once").map((grant) => grant!.id));
        await writeGrants(host, grants.map((grant) => once.has(grant.id) ? { ...grant, revoked: true } : grant));
        const fence = await open(pendingPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        retain = true;
        try { await fence.writeFile(JSON.stringify({ formatVersion: 1, checksum })); await fence.sync(); }
        finally { await fence.close(); }
        await (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
        const result = await run(["sudo", "-n", "pacman", "--config", configPath, "--hookdir", hookDirectory, "--ask", "75", "--upgrade", "--needed", "--noconfirm", "--noprogressbar", "--", ...payloads]);
        if (result.status !== "completed" || result.exitCode !== 0 || ("terminationUnconfirmed" in result && result.terminationUnconfirmed === true)) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "The privileged package transaction has no verified successful terminal result. Private installer data was retained; no locks were removed.", actions: [] }, { resumable: true });
        const final = await inventory();
        if (!final || final.missing.length) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "The completed package command did not establish the exact installed state. Private installer data was retained.", actions: [] }, { resumable: true });
        await unlink(pendingPath);
        await (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
        retain = false;
        return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Exact Arch packages are installed. Starting/enabling services and user access are separate actions; native runtime support is still unverified.", actions: [{ command: "fleur doctor", description: "Inspect separate service, access and runtime readiness." }] }, { setupAction: { action: "install", state: "completed" }, resumable: true });
      } finally { if (!retain) await rm(staging, { recursive: true, force: true }); }
    }, host.syncDirectory);
  } catch (error) { return failure("setup", 5, { code: error instanceof SetupBusy ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED", message: "Arch setup is blocked by concurrent work, unsafe private state or an indeterminate transaction.", actions: [] }); }
}
