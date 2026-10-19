import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { smokeImages } from "../src/setup/profiles.ts";
import { productionHost } from "../src/setup/host.ts";

// Run only on an owned disposable native Linux CI runner. This acquires one exact
// smoke image; it neither installs Docker nor changes services, contexts or access.
const repository = resolve(import.meta.dir, "..");
const scratch = await mkdtemp(join(tmpdir(), "fleur-native-setup-"));
const output = resolve(process.env.FLEUR_NATIVE_REPORT ?? "native-setup.json");
const observations: Record<string, unknown> = {
  formatVersion: 1, scope: "native-existing-docker", verifiedReleaseProfile: false,
  bun: Bun.version, bunRevision: Bun.revision, architecture: process.arch,
  sourceCommit: process.env.GITHUB_SHA ?? null, runs: [],
};
let cleanupSentinel: (() => Promise<void>) | undefined;
async function run(args: string[], expected = 0): Promise<string> {
  const result = await productionHost().run(args, 120000);
  if (result.status !== "completed" || result.exitCode !== expected) throw new Error(`${args[0]} ${args[1] ?? ""}: expected ${expected}, received ${result.status}/${result.exitCode}: ${result.stderr.slice(-4096)} ${result.stdout.slice(-4096)}`);
  return result.stdout;
}
try {
  if (process.env.FLEUR_OWNED_DISPOSABLE_HOST !== "yes") throw new Error("Explicit FLEUR_OWNED_DISPOSABLE_HOST=yes opt-in required before Docker access.");
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Native Linux amd64/arm64 runner required.");
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
  const docker = (...args: string[]) => run(["docker", "--host", endpoint, ...args]);
  async function originalContext(): Promise<string> {
    if (ambientHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = ambientHost;
    if (ambientContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = ambientContext;
    try { return await run(["docker", "context", "show"]); }
    finally { delete process.env.DOCKER_CONTEXT; process.env.DOCKER_HOST = endpoint as string; }
  }
  observations.endpoint = "local-unix";
  observations.osRelease = await readFile("/etc/os-release", "utf8");
  observations.kernel = (await run(["uname", "-srmo"])).trim();
  observations.docker = JSON.parse(await docker("version", "--format", "{{json .}}"));
  observations.compose = (await docker("compose", "version", "--short")).trim();
  const image = smokeImages[process.arch];
  if (!image) throw new Error("No exact smoke image for architecture.");
  await docker("pull", image);
  const imageMetadata = JSON.parse(await docker("image", "inspect", image));
  observations.image = imageMetadata;
  const imageId = imageMetadata[0]?.Id;
  if (typeof imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Pinned image inspection did not supply a full image identity.");
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
  for (let pass = 0; pass < 2; pass++) {
    // A successful disposable smoke is evidence, not permission to silently
    // promote this unknown runner's tool versions to a supported release profile.
    const result = JSON.parse(await run([process.execPath, join(scratch, "package", "bin", "fleur.ts"), "doctor", "--json", "--timeout", "60"], 4));
    runs.push(result);
    observations.runs = runs;
    if (result.formatVersion !== 1 || result.command !== "doctor" || result.ok !== false || result.truncated !== false || result.error?.code !== "PREREQUISITE_UNAVAILABLE" || result.data?.components?.release?.state !== "unverified" || result.data?.components?.smoke?.state !== "ready" || result.data?.components?.smoke?.cleanup !== true || result.data?.components?.daemon?.state !== "ready" || result.data?.components?.compose?.state !== "ready") throw new Error("Packed doctor did not prove native smoke readiness with honest unverified profile status.");
    const after = (await docker("ps", "--all", "--quiet", "--no-trunc")).trim().split("\n").sort().join("\n");
    if (before !== after || beforeContext !== await originalContext()) throw new Error("Doctor changed global context or altered container inventory.");
    if (await sentinelSnapshot() !== sentinelBefore) throw new Error("Doctor altered the unrelated stopped container state or configuration.");
    observations.sentinel = { id: sentinelId, image: imageId, state: "created", unchangedRounds: pass + 1 };
  }
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
  await writeFile(output, `${JSON.stringify(observations, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
}
