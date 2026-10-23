import { expect, test } from "bun:test";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native verification requires disposable-host opt-in before any prerequisite access", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-optin-"));
  try {
    const report = join(scratch, "report.json");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
      env: { ...process.env, PATH: scratch, FLEUR_OWNED_DISPOSABLE_HOST: undefined, FLEUR_NATIVE_REPORT: report },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
    expect(await child.exited).toBe(1);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.ok).toBe(false);
    expect(observed.error).toBe("Explicit FLEUR_OWNED_DISPOSABLE_HOST=yes opt-in required before Docker access.");
    expect(observed.runs).toEqual([]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});


test("existing Docker verification reports missing image authority without pulling or changing a personal host", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-existing-docker-"));
  try {
    const report = join(scratch, "report.json");
    const calls = join(scratch, "calls.log");
    const docker = join(scratch, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEUR_TEST_COMMANDS"
case "$*" in
  "context show") printf 'local\\n' ;;
  "context inspect "*) printf '{"Host":"unix:///tmp/fleur-native-fixture.sock"}\\n' ;;
  *" compose version --short") printf '5.6.0\\n' ;;
  *" version --format "*) printf '{"Server":{"Version":"29.9.2","KernelVersion":"7.0.14-linuxkit","Os":"linux","Arch":"amd64"}}\\n' ;;
  *" info --format "*) printf '{"ID":"fixture-existing-engine","ServerVersion":"29.9.2","KernelVersion":"7.0.14-linuxkit","OSType":"linux","Architecture":"x86_64","CgroupDriver":"cgroupfs","CgroupVersion":"2","MemoryLimit":true,"PidsLimit":true,"CpuCfsPeriod":true,"CpuCfsQuota":true,"SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"]}\\n' ;;
  *" image inspect "*) printf 'Error response from daemon: No such image: smoke\\n' >&2; exit 1 ;;
  *) exit 97 ;;
esac
`);
    await chmod(docker, 0o700);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
      env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin:/usr/sbin:/sbin`, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined, FLEUR_OWNED_DISPOSABLE_HOST: undefined, FLEUR_EXISTING_DOCKER_ONLY: "yes", FLEUR_NATIVE_REPORT: report, FLEUR_TEST_COMMANDS: calls },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
    expect(await child.exited).toBe(1);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.requiredAction).toEqual({ action: "image-acquire", method: "docker-digest-pull", image: process.arch === "arm64" ? "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" : "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e" });
    expect(observed.verifiedReleaseProfile).toBe(false);
    expect(observed.runs).toEqual([]);
    const commands = (await readFile(calls, "utf8")).trim().split("\n");
    expect(commands.some((command) => command.includes(" image inspect "))).toBe(true);
    expect(commands.some((command) => /(?:^| )(pull|create|run|rm|start|stop|prune|use)(?: |$)/.test(command))).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("native verification records bounded daemon metadata from its own run without leaking unrelated info", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-metadata-"));
  try {
    const report = join(scratch, "report.json");
    const calls = join(scratch, "calls.log");
    const info = { ID: "fixture-native-engine", ServerVersion: "28.0.4", KernelVersion: "6.17.0-1022-azure", OSType: "linux", Architecture: "aarch64", CgroupDriver: "systemd", CgroupVersion: "2", MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, SecurityOptions: ["name=seccomp,profile=builtin", "name=apparmor", "name=cgroupns"], HTTPProxy: "private-proxy-sentinel", Labels: ["private-label-sentinel"] };
    const docker = join(scratch, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEUR_TEST_COMMANDS"
case "$*" in
  "context show") printf 'local\\n' ;;
  "context inspect "*) printf '{"Host":"unix:///tmp/fleur-native-fixture.sock"}\\n' ;;
  *" compose version --short") printf '2.38.2\\n' ;;
  *" version --format "*) printf '{"Server":{"Version":"28.0.4","KernelVersion":"6.17.0-1022-azure","Os":"linux","Arch":"arm64"}}\\n' ;;
  *" info --format "*) printf '%s\\n' '${JSON.stringify(info)}' ;;
  *" image inspect "*) printf 'No such image\\n' >&2; exit 1 ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
      env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin:/usr/sbin:/sbin`, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined, FLEUR_EXISTING_DOCKER_ONLY: "yes", FLEUR_NATIVE_REPORT: report, FLEUR_TEST_COMMANDS: calls },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
    expect(await child.exited).toBe(1); // Missing image remains separately authorized.
    const bytes = await readFile(report, "utf8");
    const observed = JSON.parse(bytes);
    expect(observed.daemon).toEqual({ ID: "fixture-native-engine", ServerVersion: "28.0.4", KernelVersion: "6.17.0-1022-azure", OSType: "linux", Architecture: "aarch64", CgroupDriver: "systemd", CgroupVersion: "2", MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, SecurityOptions: ["name=apparmor", "name=cgroupns", "name=seccomp,profile=builtin"] });
    expect(bytes).not.toContain("private-proxy-sentinel");
    expect(bytes).not.toContain("private-label-sentinel");
    expect(observed.requiredAction?.action).toBe("image-acquire");
    expect(observed.verifiedReleaseProfile).toBe(false);
    expect(observed.installationVerified).toBe(false);
    const commands = (await readFile(calls, "utf8")).trim().split("\n");
    expect(commands.some((command) => command.includes(" info --format "))).toBe(true);
    expect(commands.some((command) => /(?:^| )(pull|create|run|rm|start|stop|prune|use)(?: |$)/.test(command))).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const mismatch of ["version", "kernel", "architecture"] as const) {
  test(`native verification refuses ${mismatch} disagreement between daemon metadata and server builds before image access`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fleur-native-inconsistent-"));
    try {
      const report = join(scratch, "report.json");
      const calls = join(scratch, "calls.log");
      const server = { Version: mismatch === "version" ? "28.0.5" : "28.0.4", KernelVersion: mismatch === "kernel" ? "6.17.0-1023-azure" : "6.17.0-1022-azure", Os: "linux", Arch: mismatch === "architecture" ? "amd64" : "arm64" };
      await writeFile(join(scratch, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEUR_TEST_COMMANDS"
case "$*" in
  "context show") printf 'local\\n' ;;
  "context inspect "*) printf '{"Host":"unix:///tmp/fleur-native-fixture.sock"}\\n' ;;
  *" compose version --short") printf '2.38.2\\n' ;;
  *" version --format "*) printf '%s\\n' '${JSON.stringify({ Server: server })}' ;;
  *" info --format "*) printf '{"ID":"fixture-engine","ServerVersion":"28.0.4","KernelVersion":"6.17.0-1022-azure","OSType":"linux","Architecture":"aarch64","CgroupDriver":"systemd","CgroupVersion":"2","MemoryLimit":true,"PidsLimit":true,"CpuCfsPeriod":true,"CpuCfsQuota":true,"SecurityOptions":["name=seccomp,profile=builtin","name=cgroupns"]}\\n' ;;
  *" image inspect "*) printf 'No such image\\n' >&2; exit 1 ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
        env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin:/usr/sbin:/sbin`, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined, FLEUR_EXISTING_DOCKER_ONLY: "yes", FLEUR_NATIVE_REPORT: report, FLEUR_TEST_COMMANDS: calls },
        stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
      });
      expect(await child.exited).toBe(1);
      const observed = JSON.parse(await readFile(report, "utf8"));
      expect(observed.error).toBe("Native daemon metadata and server build identity disagree.");
      expect(observed.requiredAction).toBeUndefined();
      expect(observed.ok).toBe(false);
      const commands = (await readFile(calls, "utf8")).trim().split("\n");
      expect(commands.some((command) => command.includes(" image inspect "))).toBe(false);
      expect(commands.some((command) => /(?:^| )(pull|create|run|rm|start|stop|prune|use)(?: |$)/.test(command))).toBe(false);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}

async function completeNativeVerification(change: "none" | "daemon" | "server" | "capability", qualified = false) {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-rounds-"));
  try {
    const report = join(scratch, "report.json");
    const state = join(scratch, "docker-state.json");
    await writeFile(state, JSON.stringify({ containers: {}, infoReads: 0, versionReads: 0, operations: [] }));
    await writeFile(join(scratch, "docker"), `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const path = process.env.FLEUR_TEST_STATE;
const state = JSON.parse(readFileSync(path, "utf8"));
let args = process.argv.slice(2);
state.operations.push(args);
if (args[0] === "--host") args = args.slice(2);
const command = args[0];
const id = "a".repeat(64);
const image = process.arch === "arm64" ? "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" : "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e";
const imageId = "sha256:" + "c".repeat(64);
let output;
if (command === "--version") output = "Docker version 28.0.4, build b8034c0";
else if (command === "context") output = args[1] === "show" ? "local" : JSON.stringify({ Host: "unix:///tmp/fleur-native-fixture.sock" });
else if (command === "compose") output = "2.38.2";
else if (command === "info") {
  state.infoReads++;
  output = JSON.stringify({ ID: ${JSON.stringify(change)} === "daemon" && state.infoReads >= 3 ? "replacement-engine" : "original-engine", ServerVersion: "28.0.4", KernelVersion: "fixture-kernel", OSType: "linux", Architecture: process.arch === "arm64" ? "aarch64" : "x86_64", CgroupDriver: ${JSON.stringify(change)} === "capability" && state.infoReads >= 3 ? "cgroupfs" : "systemd", CgroupVersion: "2", MemoryLimit: true, PidsLimit: true, CpuCfsPeriod: true, CpuCfsQuota: true, SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"] });
} else if (command === "version") {
  state.versionReads++;
  const server = { Version: "28.0.4", KernelVersion: "fixture-kernel", Os: "linux", Arch: process.arch === "arm64" ? "arm64" : "amd64", GitCommit: ${JSON.stringify(change)} === "server" && state.versionReads >= 2 ? "changed-build" : "6430e49", Platform: { Name: "Docker Engine - Community" }, Components: [{ Name: "Engine", Version: "28.0.4", Details: { GitCommit: "6430e49" } }, { Name: "containerd", Version: "v2.4.1", Details: { GitCommit: "f2551031d7276a770f65f98c9b52e57e7dad07e8" } }, { Name: "runc", Version: "1.5.2", Details: { GitCommit: "v1.5.2-0-g29dd3dc2" } }] };
  output = JSON.stringify(args.at(-1) === "{{json .Server}}" ? server : { Server: server });
} else if (command === "image") output = JSON.stringify(args.includes("--format") ? { Id: imageId, RepoDigests: [image], Os: "linux", Architecture: process.arch === "arm64" ? "arm64" : "amd64" } : [{ Id: imageId }]);
else if (command === "ps") output = Object.keys(state.containers).join("\\n");
else if (command === "create") {
  const name = args[args.indexOf("--name") + 1];
  const label = args[args.indexOf("--label") + 1].split("=");
  const containerId = name.startsWith("fleur-native-unrelated-") ? "b".repeat(64) : id;
  state.containers[containerId] = { Id: containerId, Name: "/" + name, Image: imageId, Config: { Labels: { [label[0]]: label[1] } }, HostConfig: {}, State: { Running: false, ExitCode: 0, Status: "created", FinishedAt: "0001-01-01T00:00:00Z" } };
  output = containerId;
} else if (command === "inspect") output = JSON.stringify(state.containers[args[1]]);
else if (command === "start") { state.containers[args.at(-1)].State.FinishedAt = "2026-10-23T00:00:00Z"; output = "fleur-doctor-smoke"; }
else if (command === "rm") { delete state.containers[args.at(-1)]; output = args.at(-1); }
else throw new Error("Unexpected fixture operation " + JSON.stringify(args));
writeFileSync(path, JSON.stringify(state));
if (output === undefined) process.exit(97);
process.stdout.write(output + (command === "start" ? "" : "\\n"));
`, { mode: 0o700 });
    let verifier = resolve(import.meta.dir, "../../scripts/verify-native-setup.ts");
    if (qualified) {
      const repository = resolve(import.meta.dir, "../..");
      const source = join(scratch, "trusted-fixture-build");
      await mkdir(source);
      for (const name of ["src", "bin", "docs"]) await cp(join(repository, name), join(source, name), { recursive: true });
      await copyFile(join(repository, "package.json"), join(source, "package.json"));
      await mkdir(join(source, "scripts"));
      verifier = join(source, "scripts/verify-native-setup.ts");
      await copyFile(join(repository, "scripts/verify-native-setup.ts"), verifier);
      const native = await (await import("../../src/setup/host.ts")).productionHost().host();
      // A trusted test-build catalog, never a public profile override or native evidence.
      const profile = { id: "fixture-native-verified", host: { system: native.system, distribution: native.distribution ?? null, release: native.release, architecture: native.architecture }, bun: "1.4.3", cli: { version: "28.0.4", commit: "b8034c0" }, engine: { version: "28.0.4", commit: "6430e49", kernel: "fixture-kernel", platform: "Docker Engine - Community", cgroupDriver: "systemd", cgroupVersion: "2", operatingMode: "rootful", securityOptions: ["name=cgroupns", "name=seccomp,profile=builtin"] }, containerd: { version: "v2.4.1", commit: "f2551031d7276a770f65f98c9b52e57e7dad07e8" }, runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" }, compose: "2.38.2", image: process.arch === "arm64" ? "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" : "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e", evidence: { readinessSha256: "1".repeat(64), isolationSha256: "2".repeat(64) } };
      await writeFile(join(source, "src/setup/verified-readiness-profiles.ts"), `export const verifiedReadinessProfiles = ${JSON.stringify([profile])} as const;\n`);
    }
    const child = Bun.spawn([process.execPath, verifier], {
      env: { ...process.env, HOME: scratch, PATH: `${scratch}:/usr/bin:/bin:/usr/sbin:/sbin`, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined, FLEUR_EXISTING_DOCKER_ONLY: "yes", FLEUR_NATIVE_REPORT: report, FLEUR_TEST_STATE: state },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 25000,
    });
    const exit = await child.exited;
    return { exit, report: JSON.parse(await readFile(report, "utf8")), state: JSON.parse(await readFile(state, "utf8")) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

test("native verifier accepts two ready rounds only when its trusted build already admits the exact tuple", async () => {
  const result = await completeNativeVerification("none", true);
  expect(result.exit, result.report.error).toBe(0);
  expect(result.report).toMatchObject({ ok: true, verifiedReleaseProfile: true, installationVerified: false, sentinelCleanup: true });
  expect(result.report.runs).toHaveLength(2);
  for (const round of result.report.runs) expect(round).toMatchObject({ ok: true, error: null, data: { components: { release: { state: "verified", profile: "fixture-native-verified" }, smoke: { state: "ready", cleanup: true } } } });
  expect(result.state.containers).toEqual({});
}, 30000);

test("native verification correlates both packed smoke rounds with an unchanged daemon and server build", async () => {
  const result = await completeNativeVerification("none");
  expect(result.exit, result.report.error).toBe(0);
  expect(result.report).toMatchObject({ ok: true, verifiedReleaseProfile: false, installationVerified: false, sentinelCleanup: true, sentinel: { unchangedRounds: 2 } });
  expect(result.report.runs).toHaveLength(2);
  expect(result.state.containers).toEqual({});
  expect(result.state.versionReads).toBe(3);
  // Initial verifier selection, then Doctor selection and preservation check per round.
  expect(result.state.operations.filter((args: string[]) => args.join(" ") === "context show")).toHaveLength(5);
  expect(result.state.operations.some((args: string[]) => args[0] === "context" && args[1] === "use")).toBe(false);
}, 30000);

for (const change of ["daemon", "server", "capability"] as const) {
  test(`native verification rejects ${change} drift after packed smoke and still retires its sentinel`, async () => {
    const result = await completeNativeVerification(change);
    expect(result.exit).toBe(1);
    expect(result.report).toMatchObject({ ok: false, verifiedReleaseProfile: false, installationVerified: false, sentinelCleanup: true, error: "Native daemon identity or server build changed during verification." });
    expect(result.report.runs).toHaveLength(1);
    expect(result.state.containers).toEqual({});
    expect(result.state.operations.filter((args: string[]) => args.join(" ") === "context show")).toHaveLength(3);
    expect(result.state.operations.some((args: string[]) => args[0] === "context" && args[1] === "use")).toBe(false);
  }, 30000);
}

for (const failure of ["nonzero", "malformed"] as const) {
  test(`native daemon metadata ${failure} failure never copies raw diagnostics into its report`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fleur-native-info-failure-"));
    try {
      const report = join(scratch, "report.json");
      await writeFile(join(scratch, "docker"), `#!/bin/sh
case "$*" in
  "context show") printf 'local\\n' ;;
  "context inspect "*) printf '{"Host":"unix:///tmp/fleur-native-fixture.sock"}\\n' ;;
  *" compose version --short") printf '2.38.2\\n' ;;
  *" version --format "*) printf '{"Server":{"Version":"28.0.4"}}\\n' ;;
  *" info --format "*) printf 'private-proxy-error-sentinel private-label-error-sentinel'; printf 'private-stderr-sentinel' >&2; exit ${failure === "nonzero" ? 1 : 0} ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
        env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin:/usr/sbin:/sbin`, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined, FLEUR_EXISTING_DOCKER_ONLY: "yes", FLEUR_NATIVE_REPORT: report },
        stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
      });
      expect(await child.exited).toBe(1);
      const bytes = await readFile(report, "utf8");
      expect(bytes).not.toContain("private-proxy-error-sentinel");
      expect(bytes).not.toContain("private-label-error-sentinel");
      expect(bytes).not.toContain("private-stderr-sentinel");
      expect(JSON.parse(bytes)).toMatchObject({ ok: false, runs: [], error: "Native daemon capability metadata is unavailable or unsupported." });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
