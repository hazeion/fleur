/** Conservative Desktop control preflight. Never release or runtime admission. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostCommandResult, SetupHost } from "../src/setup/commands.ts";
import { productionHost } from "../src/setup/host.ts";
import { smokeImages } from "../src/setup/profiles.ts";
export interface DesktopControlBinding {
  readonly nonce: string;
  readonly workerId: string;
  readonly workerPid: number;
  readonly managerPid: number;
  readonly kernel: string;
}
export interface DesktopControlContainer {
  readonly name: string;
  readonly id?: string;
  readonly image: string;
  readonly nonce: string;
  readonly kind: "worker" | "manager";
  readonly command: readonly string[];
  readonly environment: readonly string[];
}
export function desktopControlInspectAbsent(result: HostCommandResult, target: string): boolean {
  if (!/^(?:[a-f0-9]{64}|fleur-desktop-(?:worker|manager)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(target)
      || result.status !== "completed" || result.terminationUnconfirmed === true || result.exitCode !== 1) return false;
  return (result.stdout === "" && [`Error: No such object: ${target}\n`, `Error response from daemon: No such container: ${target}\n`].includes(result.stderr))
    || (result.stdout === "\n" && result.stderr === `error: no such object: ${target}\n`);
}
export function acceptDesktopControlContainer(value: unknown, expected: DesktopControlContainer): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected.id ?? "") || !/^sha256:[a-f0-9]{64}$/.test(expected.image)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(expected.nonce)
      || expected.name !== `fleur-desktop-${expected.kind}-${expected.nonce}` || !object(value)
      || value.Id !== expected.id || value.Name !== `/${expected.name}` || value.Image !== expected.image
      || !Array.isArray(value.Mounts) || value.Mounts.length !== 0 || !object(value.Config) || !object(value.HostConfig) || !object(value.State)) return false;
  const config = value.Config; const host = value.HostConfig; const manager = expected.kind === "manager";
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const empty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  const capabilities = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item: string) => item.replace(/^CAP_/, "")).sort() : value;
  const security = Array.isArray(host.SecurityOpt) && host.SecurityOpt.every((item) => typeof item === "string") ? host.SecurityOpt.map((item: string) => item === "no-new-privileges:true" ? "no-new-privileges" : item).sort() : host.SecurityOpt;
  return object(config.Labels) && config.Labels["dev.fleur.desktop-control-owner"] === expected.nonce && config.Labels["dev.fleur.desktop-control-role"] === expected.kind
    && config.User === (manager ? "0:0" : "65534:65534") && same(config.Entrypoint, ["/usr/local/bin/bun"]) && same(config.Cmd, expected.command)
    && Array.isArray(config.Env) && config.Env.every((item) => typeof item === "string")
    && same(config.Env.filter((item: string) => item.startsWith("FLEUR_CONTROL_")).sort(), [...expected.environment].sort())
    && (config.Volumes === null || config.Volumes === undefined) && host.Privileged === false && empty(host.Binds) && empty(host.Mounts)
    && empty(host.Devices) && empty(host.DeviceRequests) && empty(host.VolumesFrom) && host.NetworkMode === "none" && host.ReadonlyRootfs === true
    && host.PidMode === (manager ? "host" : "") && host.CgroupnsMode === (manager ? "host" : "private")
    && same(capabilities(host.CapDrop), ["ALL"]) && (manager ? same(capabilities(host.CapAdd), ["KILL", "SYS_PTRACE"]) : empty(host.CapAdd))
    && host.Memory === (manager ? 268435456 : 536870912) && host.MemorySwap === host.Memory && host.NanoCpus === 1000000000 && host.PidsLimit === 64
    && (manager
      ? same(security, ["no-new-privileges", "seccomp=unconfined"]) || same(security, ["label=disable", "no-new-privileges", "seccomp=unconfined"])
      : same(security, ["no-new-privileges"]))
    && typeof value.State.Running === "boolean" && Number.isSafeInteger(value.State.Pid) && (value.State.Pid as number) >= 0 && (value.State.Pid as number) < 2 ** 31;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function shape(value: unknown, keys: string): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join(",") === keys.split(",").sort().join(",");
}
export function acceptDesktopControlProbe(value: unknown, binding: DesktopControlBinding): boolean {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 1 && (value as number) < 2 ** 31;
  const positive = (value: unknown) => typeof value === "string" && /^[1-9][0-9]{0,23}$/.test(value);
  const namespace = (value: unknown) => typeof value === "string" && /^pid:\[[1-9][0-9]{0,15}\]$/.test(value);
  if (!uuid.test(binding.nonce) || !/^[a-f0-9]{64}$/.test(binding.workerId) || !pid(binding.workerPid) || !pid(binding.managerPid)
      || binding.workerPid === binding.managerPid || !/^[A-Za-z0-9._+-]{1,128}$/.test(binding.kernel)) return false;
  if (!shape(value, "formatVersion,scope,ok,runtimeAdmission,nonce,workerId,workerPid,managerPid,kernel,architecture,uid,bootId,vmMonotonicNs,custodyStable,worker,managerPidNamespace,hostPidNamespace,pidfd")
      || value.formatVersion !== 1 || value.scope !== "desktop-linux-control-capability" || value.ok !== true || value.runtimeAdmission !== false
      || value.nonce !== binding.nonce || value.workerId !== binding.workerId || value.workerPid !== binding.workerPid || value.managerPid !== binding.managerPid
      || value.kernel !== binding.kernel || value.architecture !== "x86_64" || value.uid !== 0 || typeof value.bootId !== "string"
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.bootId) || !positive(value.vmMonotonicNs) || value.custodyStable !== true
      || !namespace(value.managerPidNamespace) || value.managerPidNamespace !== value.hostPidNamespace
      || !shape(value.worker, "startTime,cgroup,pidNamespace") || !positive(value.worker.startTime)
      || !namespace(value.worker.pidNamespace) || value.worker.pidNamespace === value.managerPidNamespace
      || ![`0::/docker/${binding.workerId}\n`, `0::/system.slice/docker-${binding.workerId}.scope\n`].includes(value.worker.cgroup as string)
      || !shape(value.pidfd, "fdInfoPid,signalZero,pollQuiet,closed") || value.pidfd.fdInfoPid !== binding.workerPid
      || value.pidfd.signalZero !== true || value.pidfd.pollQuiet !== true || value.pidfd.closed !== true) return false;
  return true;
}

const repository = resolve(import.meta.dir, "..");
const sources = ["scripts/observe-desktop-control.ts", "scripts/desktop-control-probe.ts", "src/setup/host.ts", "src/setup/commands.ts", "src/setup/profiles.ts", "package.json"] as const;
const hash = (value: string | Uint8Array) => Bun.CryptoHasher.hash("sha256", value, "hex");

/** Test-only host seam; executable selection is limited to source-owned candidates. */
export async function observeDesktopControl(host: SetupHost = productionHost(), candidate = "desktop-4.96.1-244132") {
  const report: Record<string, unknown> = { formatVersion: 1, scope: "native-intel-desktop-control-preflight", ok: false, runtimeAdmission: false, nativeQualification: false, installationVerified: false, imageAcquisition: "none", containers: [], cleanup: [] };
  const deadline = performance.now() + 90000;
  const workDeadline = deadline - 20000;
  let endpoint: string | undefined;
  let managerSource: string | undefined;
  let transportUncertain = false;
  const owned: DesktopControlContainer[] = [];
  let original: { context: string; daemon: string; containers: string; images: string } | undefined;
  const raw = async (args: string[], cleanup = false) => {
    const budget = Math.floor(Math.min(5000, (cleanup ? deadline : workDeadline) - performance.now()));
    if (budget <= 0) throw new Error("ORIGINAL_DEADLINE_EXPIRED");
    const result = await host.run(args, budget, { cwd: repository });
    if (result.status !== "completed" || result.terminationUnconfirmed === true) { transportUncertain = true; throw new Error("TRANSPORT_UNCONFIRMED"); }
    return result;
  };
  const command = async (args: string[], cleanup = false) => {
    const result = await raw(args, cleanup);
    if (result.exitCode !== 0 || result.stderr) throw new Error("FIXED_COMMAND_FAILED");
    return result.stdout;
  };
  const docker = (args: string[], cleanup = false) => command(["docker", "--host", endpoint!, ...args], cleanup);
  const inspect = async (target: string, cleanup = false): Promise<Record<string, unknown> | null> => {
    const result = await raw(["docker", "--host", endpoint!, "inspect", target, "--format", "{{json .}}"], cleanup);
    if (result.exitCode === 0 && !result.stderr) {
      const value: unknown = JSON.parse(result.stdout); if (!object(value)) throw new Error("INSPECTION_SHAPE_UNKNOWN"); return value;
    }
    if (desktopControlInspectAbsent(result, target)) return null;
    throw new Error("INSPECTION_OUTCOME_UNKNOWN");
  };
  const inventory = async (cleanup = false) => ({
    context: await command(["docker", "context", "show"], cleanup),
    daemon: await docker(["info", "--format", '{{json .ID}}|{{json .ServerVersion}}|{{json .KernelVersion}}|{{json .Architecture}}|{{json .CgroupDriver}}|{{json .CgroupVersion}}'], cleanup),
    containers: (await docker(["ps", "--all", "--quiet", "--no-trunc"], cleanup)).trim().split("\n").sort().join("\n"),
    images: (await docker(["image", "ls", "--quiet", "--no-trunc"], cleanup)).trim().split("\n").sort().join("\n"),
  });
  const create = async (kind: "worker" | "manager", image: string, nonce: string, program: string, environment: string[]) => {
    const name = `fleur-desktop-${kind}-${nonce}`;
    if (await inspect(name) !== null) throw new Error("FRESH_NAME_UNAVAILABLE");
    const planned: DesktopControlContainer = { name, image, nonce, kind, command: ["-e", program], environment };
    owned.push(planned);
    const manager = kind === "manager"; const memory = manager ? "268435456" : "536870912";
    const output = (await docker(["create", "--name", name, "--label", `dev.fleur.desktop-control-owner=${nonce}`, "--label", `dev.fleur.desktop-control-role=${kind}`,
      "--pull", "never", "--platform", "linux/amd64", "--entrypoint", "/usr/local/bin/bun", "--init=false", "--user", manager ? "0:0" : "65534:65534",
      "--network", "none", "--read-only", "--cap-drop", "ALL", ...(manager ? ["--cap-add", "KILL", "--cap-add", "SYS_PTRACE", "--pid", "host"] : []),
      "--cgroupns", manager ? "host" : "private", "--security-opt", "no-new-privileges:true", ...(manager ? ["--security-opt", "seccomp=unconfined"] : []),
      "--memory", memory, "--memory-swap", memory, "--cpus", "1", "--pids-limit", "64", ...environment.flatMap((value) => ["--env", value]), image, ...planned.command])).trim();
    if (!/^[a-f0-9]{64}$/.test(output)) throw new Error("CREATION_IDENTITY_UNKNOWN");
    const item = { ...planned, id: output }; owned[owned.length - 1] = item;
    const value = await inspect(output);
    if (!acceptDesktopControlContainer(value, item)) throw new Error("CREATED_PROFILE_CHANGED");
    await docker(["start", output]);
    return item;
  };
  const retire = async (planned: DesktopControlContainer) => {
    const current = await inspect(planned.id ?? planned.name, true);
    if (current) {
      const item = { ...planned, id: planned.id ?? current.Id as string };
      if (!acceptDesktopControlContainer(current, item)) throw new Error("CLEANUP_OWNERSHIP_UNPROVEN");
      await docker(["rm", "--force", item.id!], true);
      if (await inspect(item.id!, true) !== null) throw new Error("OWNED_REMOVAL_UNCONFIRMED");
    }
  };
  try {
    const platform = candidate === "desktop-4.96.1-244132" ? "Docker Desktop 4.96.1 (244132)"
      : candidate === "desktop-4.97.0-244584" ? "Docker Desktop 4.97.0 (244584)" : undefined;
    if (platform === undefined) throw new Error("EXACT_DESKTOP_TUPLE_REQUIRED");
    report.candidate = candidate;
    const native = await host.host();
    if (native.system !== "darwin" || native.architecture !== "x64" || native.translated !== false || Bun.version !== "1.4.3") throw new Error("NATIVE_INTEL_MAC_REQUIRED");
    if (candidate === "desktop-4.97.0-244584" && native.release !== "15.7.7") throw new Error("EXACT_DESKTOP_TUPLE_REQUIRED");
    report.nativeHost = { system: native.system, architecture: native.architecture, release: native.release, translated: native.translated };
    const commit = (await command(["git", "rev-parse", "HEAD"])).trim();
    if (!/^[a-f0-9]{40}$/.test(commit) || await command(["git", "diff", "--exit-code", "HEAD"])) throw new Error("CLEAN_COMMITTED_SOURCE_REQUIRED");
    const files: Record<string, string> = {};
    for (const path of sources) {
      const actual = await readFile(resolve(repository, path));
      if (hash(await command(["git", "show", `${commit}:${path}`])) !== hash(actual)) throw new Error("TRACKED_SOURCE_CHANGED");
      files[path] = hash(actual);
      if (path === "scripts/desktop-control-probe.ts") managerSource = actual.toString("utf8");
    }
    report.source = { commit, files };
    const context = (await command(["docker", "context", "show"])).trim();
    const environment = host.environment ?? {};
    if (environment.DOCKER_HOST && !environment.DOCKER_CONTEXT) endpoint = environment.DOCKER_HOST;
    else {
      const resolved: unknown = JSON.parse(await command(["docker", "context", "inspect", context, "--format", "{{json .Endpoints.docker}}"]));
      if (!object(resolved) || typeof resolved.Host !== "string") throw new Error("LOCAL_ENDPOINT_REQUIRED");
      endpoint = resolved.Host;
    }
    if (!endpoint.startsWith("unix:///") || endpoint.length <= 8 || endpoint.length > 4096 || /[\s?#]/.test(endpoint)
        || [...endpoint].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(endpoint)) throw new Error("LOCAL_ENDPOINT_REQUIRED");
    report.endpointSha256 = hash(endpoint);
    const version: unknown = JSON.parse(await docker(["version", "--format", "{{json .Server}}"]));
    if (!object(version) || !object(version.Platform) || version.Platform.Name !== platform || version.Version !== "29.9.2" || version.GitCommit !== "0367cbe" || version.Os !== "linux" || version.Arch !== "amd64" || version.KernelVersion !== "7.0.14-linuxkit") throw new Error("EXACT_DESKTOP_TUPLE_REQUIRED");
    if (candidate === "desktop-4.97.0-244584") {
      const compose = await docker(["compose", "version", "--short"]);
      if (compose !== "5.6.1\n") throw new Error("EXACT_DESKTOP_TUPLE_REQUIRED");
      const cli: unknown = JSON.parse(await docker(["version", "--format", "{{json .Client}}"]));
      const security = await docker(["info", "--format", "{{json .CgroupDriver}}|{{json .CgroupVersion}}|{{json .SecurityOptions}}"]);
      const component = (name: string, versionPin: string, commitPin: string) => {
        if (!Array.isArray(version.Components)) return false;
        const rows = version.Components.filter((row: unknown) => object(row) && row.Name === name);
        const row: unknown = rows[0];
        return rows.length === 1 && object(row) && row.Version === versionPin && object(row.Details) && row.Details.GitCommit === commitPin;
      };
      if (!object(cli) || cli.Version !== "29.9.2" || cli.GitCommit !== "a82e528" || cli.Os !== "darwin" || cli.Arch !== "amd64"
          || security !== '"cgroupfs"|"2"|["name=seccomp,profile=builtin","name=cgroupns"]\n'
          || !component("Engine", "29.9.2", "0367cbe") || !component("containerd", "v2.4.2", "b7a25261e029d68978bbf290df0a62fc819b3c51")
          || !component("runc", "1.5.2", "v1.5.2-0-g29dd3dc2")) throw new Error("EXACT_DESKTOP_TUPLE_REQUIRED");
      report.cli = cli; report.security = security; report.compose = "5.6.1";
    }
    report.server = version;
    original = await inventory(); report.original = Object.fromEntries(Object.entries(original).map(([key, value]) => [key, hash(value)]));
    const images: unknown = JSON.parse(await docker(["image", "inspect", smokeImages.x64!]));
    const image = Array.isArray(images) && images.length === 1 ? images[0] as Record<string, unknown> : undefined;
    if (!image || typeof image.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Architecture !== "amd64" || image.Os !== "linux"
        || !object(image.Config) || (image.Config.Volumes !== null && image.Config.Volumes !== undefined)) throw new Error("PREEXISTING_PINNED_IMAGE_REQUIRED");
    report.image = { digest: smokeImages.x64, id: image.Id };
    const nonce = crypto.randomUUID(); report.nonce = nonce;
    const worker = await create("worker", image.Id, nonce, `setTimeout(()=>{},60000);void ${JSON.stringify(nonce)};`, []);
    const before = await inspect(worker.id!);
    if (!acceptDesktopControlContainer(before, worker) || !object(before?.State) || before.State.Running !== true || !Number.isSafeInteger(before.State.Pid) || (before.State.Pid as number) <= 1) throw new Error("LIVE_OWNED_WORKER_REQUIRED");
    const workerPid = before.State.Pid as number;
    if (managerSource === undefined) throw new Error("VALIDATED_MANAGER_SOURCE_REQUIRED");
    const manager = await create("manager", image.Id, nonce, managerSource, [`FLEUR_CONTROL_PID=${workerPid}`, `FLEUR_CONTROL_WORKER=${worker.id}`, `FLEUR_CONTROL_NONCE=${nonce}`]);
    const managerBefore = await inspect(manager.id!);
    if (!acceptDesktopControlContainer(managerBefore, manager) || !object(managerBefore?.State) || managerBefore.State.Running !== true || (managerBefore.State.Pid as number) <= 1) throw new Error("LIVE_OWNED_MANAGER_REQUIRED");
    const binding = { nonce, workerId: worker.id!, workerPid, managerPid: managerBefore.State.Pid as number, kernel: version.KernelVersion as string };
    let frame: unknown;
    while (performance.now() < workDeadline) {
      const output = await docker(["logs", "--tail", "2", manager.id!]);
      if (output) { frame = JSON.parse(output); report.probe = frame; break; }
      const current = await inspect(manager.id!);
      if (!acceptDesktopControlContainer(current, manager) || !object(current?.State) || current.State.Running !== true) throw new Error("MANAGER_EXITED_WITHOUT_EVIDENCE");
      await new Promise((done) => setTimeout(done, 100));
    }
    report.binding = binding;
    if (!acceptDesktopControlProbe(frame, binding)) throw new Error("CONTROL_CAPABILITY_UNPROVEN");
    for (const item of [worker, manager]) {
      const current = await inspect(item.id!);
      if (!acceptDesktopControlContainer(current, item) || !object(current?.State) || current.State.Running !== true || current.State.Pid !== (item.kind === "worker" ? workerPid : binding.managerPid)) throw new Error("OWNED_PROCESS_CHANGED");
    }
    report.controlCapabilityVerified = true;
    report.ok = true;
  } catch (error) { report.ok = false; report.error = error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message) ? error.message : "PREFLIGHT_FAILED"; }
  finally {
    const cleanup: Record<string, unknown>[] = []; report.cleanup = cleanup;
    for (const planned of owned) {
      const result: Record<string, unknown> = { kind: planned.kind, absent: false }; cleanup.push(result);
      try {
        await retire(planned);
        result.absent = true;
      } catch { result.error = "OWNED_CLEANUP_UNCONFIRMED"; report.ok = false; }
    }
    if (original) {
      try { report.originalPreserved = JSON.stringify(await inventory(true)) === JSON.stringify(original); if (!report.originalPreserved) report.ok = false; }
      catch { report.originalPreserved = false; report.ok = false; }
    }
    report.transportUncertain = transportUncertain;
    if (transportUncertain) report.ok = false;
    report.containers = owned.map(({ name, id, kind }) => ({ name, id, kind }));
    report.elapsedMs = Math.round(performance.now() - (deadline - 90000));
  }
  return report;
}

if (import.meta.main) {
  let report: Record<string, unknown>;
  const args = process.argv.slice(2);
  const candidate = args.length === 1 ? "desktop-4.96.1-244132" : args[1]?.replace(/^--candidate=/, "");
  if (args[0] !== "--run" || (args.length !== 1 && (args.length !== 2 || !args[1]?.startsWith("--candidate="))) || process.env.FLEUR_DESKTOP_CONTROL_PREFLIGHT !== "yes") report = { formatVersion: 1, scope: "native-intel-desktop-control-preflight", ok: false, runtimeAdmission: false, nativeQualification: false, installationVerified: false, error: "EXPLICIT_PREFLIGHT_REQUIRED" };
  else report = await observeDesktopControl(productionHost(), candidate);
  process.stdout.write(JSON.stringify(report) + "\n"); process.exitCode = report.ok === true ? 0 : 4;
}
