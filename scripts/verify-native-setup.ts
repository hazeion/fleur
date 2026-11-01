import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { smokeImages } from "../src/setup/profiles.ts";
import { productionHost } from "../src/setup/host.ts";
import { readGrants } from "../src/setup/grants.ts";
import { matchReadinessServer, nativeReadinessProfiles, readinessCandidates, sameReadinessDaemon } from "../src/setup/readiness.ts";

// Legacy disposable Linux verification may acquire the exact smoke image.
// Explicit existing-only mode also supports native macOS and never pulls images.
// Neither mode installs Docker or changes services, contexts or access.
const repository = resolve(import.meta.dir, "..");
const existingOnly = process.env.FLEUR_EXISTING_DOCKER_ONLY === "yes";
const scratch = await mkdtemp(join(tmpdir(), "fleur-native-setup-"));
const output = resolve(process.env.FLEUR_NATIVE_REPORT ?? "native-setup.json");
const observations: Record<string, unknown> = {
  formatVersion: 1, scope: existingOnly ? "native-existing-docker-readiness" : "native-existing-docker", verifiedReleaseProfile: false,
  installationVerified: false, humanConsentProof: false, imageAcquisition: existingOnly ? "none" : "explicit-disposable-verifier",
  bun: Bun.version, bunRevision: Bun.revision, architecture: process.arch,
  sourceCommit: process.env.GITHUB_SHA ?? null, runs: [],
};
observations.verifierSha256 = Bun.CryptoHasher.hash("sha256", await readFile(import.meta.path), "hex");
let cleanupSentinel: (() => Promise<void>) | undefined;
async function run(args: string[], expected = 0): Promise<string> {
  const result = await productionHost().run(args, 120000);
  if (result.terminationUnconfirmed) throw new Error("Native verification command retirement is unconfirmed.");
  if (result.status !== "completed" || result.exitCode !== expected) throw new Error(`${args[0]} ${args[1] ?? ""}: expected ${expected}, received ${result.status}/${result.exitCode}: ${result.stderr.slice(-4096)} ${result.stdout.slice(-4096)}`);
  return result.stdout;
}
try {
  if (!existingOnly && process.env.FLEUR_OWNED_DISPOSABLE_HOST !== "yes") throw new Error("Explicit FLEUR_OWNED_DISPOSABLE_HOST=yes opt-in required before Docker access.");
  if ((!existingOnly && process.platform !== "linux") || !["linux", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error(existingOnly ? "Native macOS or Linux amd64/arm64 host required." : "Native Linux amd64/arm64 runner required.");
  const native = await productionHost().host();
  if (native.translated !== false) throw new Error("Native verification requires verified native execution.");
  observations.nativeHost = { system: native.system, architecture: native.architecture, release: native.release, translated: native.translated };
  process.chdir(repository);
  const beforeContext = await run(["docker", "context", "show"]);
  const ambientHost = process.env.DOCKER_HOST;
  const ambientContext = process.env.DOCKER_CONTEXT;
  let endpoint: unknown;
  if (ambientHost && !process.env.DOCKER_CONTEXT) endpoint = ambientHost;
  else endpoint = JSON.parse(await run(["docker", "context", "inspect", beforeContext.trim(), "--format", "{{json .Endpoints.docker}}"])).Host;
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///") || endpoint.length <= 8 || /[?#]/.test(endpoint) || [...endpoint].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || endpoint.length > 4096 || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(endpoint)) throw new Error("Only an existing local Unix Docker endpoint is allowed; no image acquired.");
  delete process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = endpoint;
  const localEndpoint = endpoint;
  const docker = (...args: string[]) => run(["docker", "--host", localEndpoint, ...args]);
  async function daemonSnapshot(): Promise<Record<string, unknown>> {
    const result = await productionHost().run(["docker", "--host", localEndpoint, "info", "--format", "{{json .}}"], 120000);
    if (result.status !== "completed" || result.exitCode !== 0 || result.terminationUnconfirmed) throw new Error("Native daemon capability metadata is unavailable or unsupported.");
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { throw new Error("Native daemon capability metadata is unavailable or unsupported."); }
    if (!sameReadinessDaemon(value, value)) throw new Error("Native daemon capability metadata is unavailable or unsupported.");
    const info = value as Record<string, unknown>;
    const keys = ["ID", "ServerVersion", "KernelVersion", "OSType", "Architecture", "CgroupDriver", "CgroupVersion", "MemoryLimit", "PidsLimit", "CpuCfsPeriod", "CpuCfsQuota"];
    return { ...Object.fromEntries(keys.map((key) => [key, info[key]])), SecurityOptions: [...info.SecurityOptions as string[]].sort() };
  }
  async function originalContext(): Promise<string> {
    if (ambientHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = ambientHost;
    if (ambientContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = ambientContext;
    try { return await run(["docker", "context", "show"]); }
    finally { delete process.env.DOCKER_CONTEXT; process.env.DOCKER_HOST = endpoint as string; }
  }
  observations.endpoint = "local-unix";
  observations.osRelease = process.platform === "darwin" ? (await run(["sw_vers", "-productVersion"])).trim() : await readFile("/etc/os-release", "utf8");
  observations.kernel = (await run(["uname", process.platform === "darwin" ? "-srm" : "-srmo"])).trim();
  observations.docker = JSON.parse(await docker("version", "--format", "{{json .}}"));
  observations.compose = (await docker("compose", "version", "--short")).trim();
  const originalDaemon = await daemonSnapshot();
  observations.daemon = originalDaemon;
  const originalServer = (observations.docker as { Server?: Record<string, unknown> } | null)?.Server;
  const serverArchitecture = ["amd64", "x86_64"].includes(String(originalDaemon.Architecture)) ? "amd64"
    : ["arm64", "aarch64"].includes(String(originalDaemon.Architecture)) ? "arm64" : undefined;
  if (!originalServer || originalServer.Version !== originalDaemon.ServerVersion || originalServer.KernelVersion !== originalDaemon.KernelVersion || originalServer.Os !== "linux" || !serverArchitecture || originalServer.Arch !== serverArchitecture) throw new Error("Native daemon metadata and server build identity disagree.");
  const image = smokeImages[process.arch];
  if (!image) throw new Error("No exact smoke image for architecture.");
  let imageBody: string;
  if (existingOnly) {
    const inspected = await productionHost().run(["docker", "--host", endpoint, "image", "inspect", image], 120000);
    if (inspected.status !== "completed" || inspected.exitCode !== 0) {
      if (inspected.status === "completed" && /no such (?:image|object)/i.test(inspected.stderr)) observations.requiredAction = { action: "image-acquire", method: "docker-digest-pull", image };
      throw new Error("The exact smoke image must already be present; use separately authorized Fleur setup. No image was acquired by this verifier.");
    }
    imageBody = inspected.stdout;
    observations.imagePresence = "preexisting";
  } else {
    await docker("pull", image);
    imageBody = await docker("image", "inspect", image);
  }
  const imageMetadata = JSON.parse(imageBody);
  observations.image = imageMetadata;
  const imageId = imageMetadata[0]?.Id;
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Pinned image inspection did not supply a full image identity.");
  const cli = await run(["docker", "--version"]);
  observations.cli = cli.trim();
  const admitted = matchReadinessServer(readinessCandidates(nativeReadinessProfiles, native, Bun.version, cli, String(observations.compose), image, originalDaemon), native, originalServer);
  const inventory = async () => (await docker("ps", "--all", "--quiet", "--no-trunc")).trim().split("\n").sort().join("\n");
  const originalInventory = await inventory();
  const nonce = crypto.randomUUID();
  const sentinelName = `fleur-native-unrelated-${nonce}`;
  let sentinelId: string | undefined;
  async function sentinelSnapshot(): Promise<string> {
    const inspected = JSON.parse(await docker("inspect", sentinelId ?? sentinelName, "--format", "{{json .}}"));
    if (typeof inspected.Id !== "string" || !/^[a-f0-9]{64}$/.test(inspected.Id) || (sentinelId !== undefined && inspected.Id !== sentinelId) || inspected.Name !== `/${sentinelName}` || inspected.Image !== imageId || inspected.Config?.Labels?.["dev.fleur.native-sentinel-owner"] !== nonce || inspected.Config?.Labels?.["dev.fleur.doctor-owner"] !== undefined) throw new Error("Unrelated sentinel ownership could not be verified; refusing removal.");
    sentinelId = inspected.Id;
    return JSON.stringify({ id: inspected.Id, name: inspected.Name, image: inspected.Image, state: inspected.State, config: inspected.Config, hostConfig: inspected.HostConfig });
  }
  cleanupSentinel = async () => {
    await sentinelSnapshot();
    await docker("rm", "--force", sentinelId!);
    if (await inventory() !== originalInventory) throw new Error("Original container inventory was not restored after owned sentinel cleanup.");
    observations.sentinelCleanup = true;
  };
  const createdSentinel = (await docker("create", "--name", sentinelName, "--label", `dev.fleur.native-sentinel-owner=${nonce}`, "--network", "none", "--read-only", "--cap-drop", "ALL", "--pull", "never", image, "/usr/local/bin/bun", "-e", 'process.stdout.write("unrelated-sentinel")')).trim();
  if (!/^[a-f0-9]{64}$/.test(createdSentinel)) throw new Error("Sentinel creation did not return a full container identity.");
  sentinelId = createdSentinel;
  const sentinelBefore = await sentinelSnapshot();
  const sentinelState = JSON.parse(sentinelBefore).state;
  if (sentinelState.Running !== false || sentinelState.ExitCode !== 0 || sentinelState.Status !== "created") throw new Error("Unrelated sentinel was not stopped in its original created state.");
  observations.sentinel = { id: sentinelId, image: imageId, state: "created", unchangedRounds: 0 };
  const before = (await docker("ps", "--all", "--quiet", "--no-trunc")).trim().split("\n").sort().join("\n");
  const archive = join(scratch, "release.tgz");
  await run([process.execPath, "pm", "pack", "--filename", archive]);
  await run(["tar", "-xzf", archive, "-C", scratch]);
  const runs: unknown[] = [];
  const checkReadySetup = existingOnly && admitted !== undefined;
  const commands = checkReadySetup ? ["doctor", "setup"] : ["doctor"];
  const grantsSnapshot = async () => JSON.stringify((await readGrants(productionHost())).map((grant) => [grant.id, grant.action, grant.method, grant.target, grant.planChecksum, grant.machine, grant.user, grant.mode, grant.revoked]));
  const originalGrants = checkReadySetup ? await grantsSnapshot() : undefined;
  observations.completedRounds = 0;
  observations.preservationChecks = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const command of commands) {
      // Select commands from independent source-owned admission, never CLI output.
      // Unknown tuples retain two expected-failure Doctor observations.
      const result = JSON.parse(await run([process.execPath, join(scratch, "package", "bin", "fleur.ts"), command, "--json", "--timeout", "60"], admitted ? 0 : 4));
      runs.push(result);
      observations.runs = runs;
      const release = result.data?.components?.release;
      const releaseMatches = admitted
        ? result.ok === true && result.error === null && release?.state === "verified" && typeof release.floor === "string" && Array.isArray(release.measuredRows) && release.measuredRows.includes(admitted.id) && ["measured", "above-floor"].includes(release.admission) && Array.isArray(release.machineTools) && release.evidence?.readinessSha256 === admitted.evidence.readinessSha256 && release.evidence?.isolationSha256 === admitted.evidence.isolationSha256
        : result.ok === false && result.error?.code === "PREREQUISITE_UNAVAILABLE" && release?.state === "unverified";
      if (result.formatVersion !== 1 || result.command !== command || !releaseMatches || result.truncated !== false || result.data?.components?.smoke?.state !== "ready" || result.data?.components?.smoke?.cleanup !== true || result.data?.components?.daemon?.state !== "ready" || result.data?.components?.compose?.state !== "ready") throw new Error("Packed readiness did not prove native smoke cleanup with the expected source-owned release status.");
      if (command === "setup" && (result.data === null || typeof result.data !== "object" || Array.isArray(result.data) || JSON.stringify(Object.keys(result.data)) !== '["components"]')) throw new Error("Ready setup returned an unexpected action or recovery result.");
      const after = (await docker("ps", "--all", "--quiet", "--no-trunc")).trim().split("\n").sort().join("\n");
      if (before !== after || beforeContext !== await originalContext()) throw new Error("Readiness changed global context or altered container inventory.");
      if (await sentinelSnapshot() !== sentinelBefore) throw new Error("Readiness altered the unrelated stopped container state or configuration.");
      const currentDaemon = await daemonSnapshot();
      const currentVersion = JSON.parse(await docker("version", "--format", "{{json .}}"));
      if (!sameReadinessDaemon(originalDaemon, currentDaemon) || JSON.stringify(currentVersion.Server) !== JSON.stringify((observations.docker as { Server?: unknown }).Server)) throw new Error("Native daemon identity or server build changed during verification.");
      if (checkReadySetup) {
        observations.grantsPreserved = await grantsSnapshot() === originalGrants;
        if (observations.grantsPreserved !== true) throw new Error("Readiness changed setup authority.");
      }
      observations.preservationChecks = runs.length;
    }
    observations.completedRounds = pass + 1;
    observations.sentinel = { id: sentinelId, image: imageId, state: "created", unchangedRounds: pass + 1 };
  }
  if (admitted) observations.releaseProfile = { id: admitted.id, evidence: { ...admitted.evidence } };
  observations.ok = true;
} catch (error) {
  observations.ok = false;
  observations.error = error instanceof Error ? error.message : "Verification failed";
  process.exitCode = 1;
} finally {
  if (cleanupSentinel) {
    try { await cleanupSentinel(); }
    catch (error) { observations.ok = false; observations.sentinelCleanup = false; observations.cleanupError = error instanceof Error ? error.message : "Owned sentinel cleanup failed"; process.exitCode = 1; }
  }
  observations.verifiedReleaseProfile = observations.ok === true && observations.releaseProfile !== undefined;
  await writeFile(output, `${JSON.stringify(observations, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
}
