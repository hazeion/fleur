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
  observations.image = JSON.parse(await docker("image", "inspect", image));
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
  }
  observations.ok = true;
} catch (error) {
  observations.ok = false;
  observations.error = error instanceof Error ? error.message : "Verification failed";
  process.exitCode = 1;
} finally {
  await writeFile(output, `${JSON.stringify(observations, null, 2)}\n`);
  await rm(scratch, { recursive: true, force: true });
}
