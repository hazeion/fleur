import { readFile, statfs } from "node:fs/promises";
import { availableParallelism, release, totalmem } from "node:os";
import { productionHost } from "../src/setup/host.ts";
import { aptHealthArgs, healthyDpkgSnapshot } from "../src/setup/apt-health.ts";

// Read-only inventory for reviewing a later, separately guarded fresh-host plan.
// This command never prepares a host or establishes installation qualification.
const report: Record<string, unknown> = { formatVersion: 1, scope: "native-runner-read-only-inventory", nativeQualification: false, installationVerified: false, observationComplete: false };
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
async function observe(): Promise<void> {
  if (JSON.stringify(process.argv.slice(2)) !== '["--observe"]') fail("ARGUMENT_INVALID");
  const label = process.env.FLEUR_OBSERVATION_RUNNER;
  const architecture = label === "ubuntu-24.04-arm" ? "arm64" : label === "ubuntu-24.04" ? "x64" : undefined;
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "hazeion/fleur"
      || process.env.FLEUR_RUNNER_ENVIRONMENT !== "github-hosted" || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
      || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? "") || process.platform !== "linux" || process.arch !== architecture) fail("RUNNER_CONTEXT_UNAVAILABLE");
  const host = productionHost();
  const identity = await host.host();
  if (identity.distribution !== "ubuntu" || identity.release !== "24.04" || identity.translated !== false) fail("RUNNER_IDENTITY_UNAVAILABLE");
  async function command(args: string[]): Promise<string> {
    const result = await host.run(args, 10000);
    if (result.status !== "completed" || result.exitCode !== 0 || result.terminationUnconfirmed) fail("READ_ONLY_COMMAND_UNAVAILABLE");
    return result.stdout;
  }
  const source = (await command(["git", "rev-parse", "HEAD"])).trim();
  if (source !== process.env.GITHUB_SHA) fail("SOURCE_MISMATCH");
  report.context = { repository: "hazeion/fleur", runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, event: process.env.GITHUB_EVENT_NAME,
    workflow: process.env.GITHUB_WORKFLOW, workflowRef: process.env.GITHUB_WORKFLOW_REF, job: process.env.GITHUB_JOB,
    sourceCommit: source, runnerEnvironment: "github-hosted", runnerLabel: label, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion };
  report.native = { system: identity.system, architecture: identity.architecture, distribution: identity.distribution, release: identity.release, kernel: release(), bun: Bun.version };
  const health = await host.run(aptHealthArgs, 10000, { outputLimitBytes: 2097152 });
  if (health.status !== "completed" || health.exitCode !== 0 || health.terminationUnconfirmed) fail("PACKAGE_INVENTORY_UNAVAILABLE");
  const packages = healthyDpkgSnapshot(health.stdout);
  if (!packages) return fail("PACKAGE_INVENTORY_UNHEALTHY");
  const relevant = new Set(["docker-ce", "docker-ce-cli", "docker-ce-rootless-extras", "docker-buildx-plugin", "docker-compose-plugin", "docker.io", "docker-compose", "containerd.io", "containerd", "runc", "moby-engine", "moby-cli", "moby-containerd", "moby-runc", "moby-buildx", "moby-compose", "iptables", "nftables", "apparmor", "sudo", "systemd", "uidmap", "slirp4netns", "fuse-overlayfs"]);
  report.packages = Object.fromEntries([...packages].filter(([name]) => relevant.has(name.split(":")[0]!)));
  report.packageInventory = { count: packages.size, sha256: Bun.CryptoHasher.hash("sha256", health.stdout, "hex"), healthy: true };
  report.services = await command(["systemctl", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,UnitFileState,FragmentPath,ExecMainPID", "docker.service", "docker.socket", "containerd.service"]);
  const docker = (...args: string[]) => command(["docker", "--host", "unix:///var/run/docker.sock", ...args]);
  report.server = JSON.parse(await docker("version", "--format", "{{json .Server}}")) as unknown;
  report.resources = { containers: (await docker("ps", "--all", "--quiet", "--no-trunc")).trim().split("\n").filter(Boolean),
    images: [...new Set((await docker("image", "ls", "--all", "--quiet", "--no-trunc")).trim().split("\n").filter(Boolean))].sort(),
    volumes: (await docker("volume", "ls", "--quiet")).trim().split("\n").filter(Boolean) };
  const group = await host.run(["getent", "group", "docker"], 10000);
  if (group.status !== "completed" || ![0, 2].includes(group.exitCode!) || group.terminationUnconfirmed) fail("GROUP_INVENTORY_UNAVAILABLE");
  const fields = group.stdout.trim().split(":");
  report.dockerGroup = group.exitCode === 2 ? { present: false } : { present: true, name: fields[0], gid: fields[2], members: fields[3]?.split(",").filter(Boolean) };
  const capacity = await statfs(process.cwd());
  report.capacity = { cpus: availableParallelism(), memoryBytes: totalmem(), freeDiskBytes: capacity.bavail * capacity.bsize };
  report.verificationTools = Object.fromEntries(["qemu-img", "qemu-system-x86_64", "qemu-system-aarch64", "cloud-localds", "systemd-run", "ssh", "ssh-keygen", "scp", "unzip", "python3"].map((name) => [name, Bun.which(name)]));
  if (architecture === "x64") {
    const simulation = await host.run(["apt-get", "--simulate", "--no-remove", "--no-upgrade", "--no-install-recommends", "install", "qemu-system-x86", "qemu-utils", "cloud-image-utils"], 20000);
    report.hostToolPreparationSimulation = { status: simulation.status, exitCode: simulation.exitCode, terminationUnconfirmed: simulation.terminationUnconfirmed === true, stdout: simulation.stdout, stderr: simulation.stderr, executed: false };
    report.hostToolRepositoryPolicy = await command(["apt-cache", "policy", "qemu-system-x86", "qemu-utils", "cloud-image-utils"]);
  }
  report.collectorSha256 = Bun.CryptoHasher.hash("sha256", await readFile(import.meta.path), "hex");
  report.observationComplete = true;
}
try { await observe(); }
catch (error) { report.error = { code: (error as { code?: string }).code ?? "OBSERVATION_FAILED" }; process.exitCode = 4; }
process.stdout.write(JSON.stringify(report) + "\n");
