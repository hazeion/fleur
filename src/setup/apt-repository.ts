import { mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { CommandInput } from "../cli/catalog.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";
import { readGrants, stateDirectory, writeGrants, type Grant } from "./grants.ts";
import type { AptInstallProfile } from "./native.ts";
import { dockerRepositoryKey, dockerRepositoryKeySha256 } from "./docker-key.ts";

const keyPath = "/etc/apt/keyrings/docker.asc";
const sourcePath = "/etc/apt/sources.list.d/docker.sources";

/** Caller holds the setup lock; fixed root-owned paths are never replaced. */
export async function ensureAptRepository(input: CommandInput, host: SetupHost, identity: HostIdentity, profile: AptInstallProfile, target: string, checksum: string, source: string, remaining: () => number): Promise<CliOutcome | null> {
  const run = (args: readonly string[]) => remaining() > 0 ? host.run(args, remaining()) : Promise.resolve({ status: "timeout" as const, stdout: "", stderr: "" });
  const parentPaths = ["/etc", "/etc/apt", "/etc/apt/keyrings", "/etc/apt/sources.list.d"];
  const parentsSafe = async (allowMissing: boolean) => {
    const missing: string[] = [];
    for (const path of parentPaths) {
      const metadata = await run(["stat", "--format=%F|%u|%a|%h", "--", path]);
      if (allowMissing && ["/etc/apt/keyrings", "/etc/apt/sources.list.d"].includes(path) && metadata.status === "completed" && metadata.exitCode === 1 && /No such file or directory/.test(metadata.stderr)) { missing.push(path); continue; }
      if (metadata.status !== "completed" || metadata.exitCode !== 0 || !/^directory\|0\|(?:755|750|700)\|[1-9][0-9]*\s*$/.test(metadata.stdout)) throw new Error("Unsafe repository parent");
    }
    return missing;
  };
  const missingParents = await parentsSafe(true);
  const sourceOptions = ["-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/docker.sources", "-o", "Dir::Etc::sourceparts=-"];
  const indexReady = async () => {
    const available = await run(["apt-cache", ...sourceOptions, "--no-all-versions", "show", ...Object.entries(profile.packages).map(([name, version]) => `${name}=${version}`)]);
    if (available.status !== "completed" || available.exitCode !== 0 || !available.stdout.trim()) return false;
    const seen = new Set<string>();
    for (const paragraph of available.stdout.trim().split(/\n\s*\n/)) {
      const names = paragraph.split("\n").filter((line) => line.startsWith("Package: ")).map((line) => line.slice(9));
      const versions = paragraph.split("\n").filter((line) => line.startsWith("Version: ")).map((line) => line.slice(9));
      const name = names[0];
      if (names.length !== 1 || versions.length !== 1 || !name || !Object.hasOwn(profile.packages, name) || profile.packages[name as keyof typeof profile.packages] !== versions[0] || seen.has(name)) return false;
      seen.add(name);
    }
    return seen.size === Object.keys(profile.packages).length;
  };
  const states: ("ready" | "missing")[] = [];
  for (const [path, expected] of [[keyPath, dockerRepositoryKey], [sourcePath, source + "\n"]] as const) {
    const metadata = await run(["stat", "--format=%F|%u|%a|%h", "--", path]);
    if (metadata.status === "completed" && metadata.exitCode === 1 && /No such file or directory/.test(metadata.stderr)) { states.push("missing"); continue; }
    const bytes = await run(["cat", "--", path]);
    if (metadata.status !== "completed" || metadata.exitCode !== 0 || !/^regular file\|0\|(?:644|444)\|1\s*$/.test(metadata.stdout) || bytes.status !== "completed" || bytes.exitCode !== 0 || bytes.stdout !== expected) return failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "An existing repository path is unsafe or differs from the release-owned bytes. It was preserved.", actions: [] }, { resumable: true });
    states.push("ready");
  }
  if (states.every((state) => state === "ready")) { await parentsSafe(false); if (await indexReady()) return null; }
  const action = "repository-configuration";
  const repositoryChecksum = Bun.CryptoHasher.hash("sha256", JSON.stringify({ profileChecksum: checksum, keySha256: dockerRepositoryKeySha256, source, paths: [keyPath, sourcePath] }), "hex");
  const repositoryTarget = `${target} repository ${repositoryChecksum}`;
  const matches = (grant: Grant) => !grant.revoked && grant.action === action && grant.method === profile.method && grant.target === repositoryTarget && grant.planChecksum === repositoryChecksum && grant.machine === identity.machineId && grant.user === process.getuid?.();
  const grants = [...await readGrants(host)];
  let grant = grants.find(matches);
  if (!grant && input.args.length === 0 && !input.json && host.interactive && host.confirmHuman) {
    const decision = await host.confirmHuman({ action, method: profile.method, target: repositoryTarget, checksum: repositoryChecksum }, remaining());
    if (decision === "once" || decision === "remembered") {
      grant = { id: crypto.randomUUID(), action, method: profile.method, target: repositoryTarget, planChecksum: repositoryChecksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false };
      grants.push(grant);
      await writeGrants(host, grants);
    }
  }
  if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Creating the official repository and refreshing its index requires separate repository configuration authority.", actions: [{ command: "fleur setup", description: "Inspect the bounded repository configuration action." }] }, { plan: { action, method: profile.method, checksum: repositoryChecksum, target: repositoryTarget }, resumable: true });
  if (Bun.CryptoHasher.hash("sha256", dockerRepositoryKey, "hex") !== dockerRepositoryKeySha256) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The compiled repository public key does not match its authenticated digest.", actions: [] });
  // Re-read authority immediately before mutation; the caller still owns setup serialization.
  const current = [...await readGrants(host)];
  const authorized = current.find((candidate) => candidate.id === grant!.id && matches(candidate));
  if (!authorized) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Repository authority changed before configuration.", actions: [] });
  if (authorized.mode === "once") await writeGrants(host, current.map((candidate) => candidate.id === authorized.id ? { ...candidate, revoked: true } : candidate));
  const staging = await mkdtemp(join(stateDirectory(host), "repository-"));
  try {
    if (missingParents.length) {
      const created = await run(["sudo", "-n", "mkdir", "--parents", "--mode=0755", "--", ...missingParents]);
      if (created.status !== "completed" || created.exitCode !== 0) return failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "Repository directories require human OS authentication; no existing path was replaced.", actions: [] }, { resumable: true });
    }
    await parentsSafe(false);
    for (const [index, [path, expected]] of ([[keyPath, dockerRepositoryKey], [sourcePath, source + "\n"]] as const).entries()) {
      if (states[index] === "ready") continue;
      const staged = join(staging, index === 0 ? "docker.asc" : "docker.sources");
      const file = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
      try { await file.chmod(0o644); await file.writeFile(expected); await file.sync(); } finally { await file.close(); }
      await parentsSafe(false);
      const copied = await run(["sudo", "-n", "cp", "--no-clobber", "--no-target-directory", "--no-dereference", "--", staged, path]);
      const metadata = await run(["stat", "--format=%F|%u|%a|%h", "--", path]);
      const bytes = await run(["cat", "--", path]);
      if (copied.status !== "completed" || copied.exitCode !== 0 || metadata.status !== "completed" || metadata.exitCode !== 0 || !/^regular file\|0\|(?:644|444)\|1\s*$/.test(metadata.stdout) || bytes.status !== "completed" || bytes.exitCode !== 0 || bytes.stdout !== expected) return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "Create-only repository publication could not be verified. Existing files were preserved; inspect partial configuration before resuming.", actions: [] }, { resumable: true });
      await parentsSafe(false);
    }
    const updated = await run(["sudo", "-n", "apt-get", ...sourceOptions, "update"]);
    if (updated.status !== "completed" || updated.exitCode !== 0) return failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "Repository files were verified but refreshing the scoped index did not complete. Reprobe before resuming.", actions: [] }, { resumable: true, setupAction: { action, state: "incomplete" } });
    if (!(await indexReady())) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The scoped repository refresh completed but the exact pinned package records are still unavailable.", actions: [] }, { resumable: true, setupAction: { action, state: "completed" } });
    return null;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
