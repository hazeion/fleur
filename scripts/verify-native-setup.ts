import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { smokeImages } from "../src/setup/profiles.ts";

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
  const child = Bun.spawn(args, { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120000, killSignal: "SIGKILL" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== expected) throw new Error(`${args[0]} ${args[1] ?? ""}: expected ${expected}, received ${exit}: ${stderr.slice(-4096)} ${stdout.slice(-4096)}`);
  return stdout;
}
try {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Native Linux amd64/arm64 runner required.");
  observations.osRelease = await readFile("/etc/os-release", "utf8");
  observations.kernel = (await run(["uname", "-srmo"])).trim();
  observations.docker = JSON.parse(await run(["docker", "version", "--format", "{{json .}}"]));
  observations.compose = (await run(["docker", "compose", "version", "--short"])).trim();
  const image = smokeImages[process.arch];
  if (!image) throw new Error("No exact smoke image for architecture.");
  await run(["docker", "pull", image]);
  observations.image = JSON.parse(await run(["docker", "image", "inspect", image]));
  const beforeContext = await run(["docker", "context", "show"]);
  const before = (await run(["docker", "ps", "--all", "--quiet", "--filter", "label=dev.fleur.doctor-owner"])).trim();
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
    const after = (await run(["docker", "ps", "--all", "--quiet", "--filter", "label=dev.fleur.doctor-owner"])).trim();
    if (before !== after || beforeContext !== await run(["docker", "context", "show"])) throw new Error("Doctor changed global context or left an owned smoke container.");
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
