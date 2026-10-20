import { expect, test } from "bun:test";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type HostCommandResult } from "../../src/setup/commands.ts";

for (const distribution of ["ubuntu", "debian"] as const) test(`${distribution} doctor does not activate a stopped Docker service through its listening socket`, async () => {
  const calls: string[][] = [];
  const done = (stdout = "", exitCode = 0): HostCommandResult => ({ status: "completed", exitCode, stdout, stderr: "" });
  const outcome = await runCli(["doctor", "--json"], { cwd: "/tmp", handlers: setupCommands({
    host: async () => ({ system: "linux", architecture: "x64", translated: false, distribution, release: distribution === "ubuntu" ? "24.04" : "13", machineId: "a".repeat(64) }),
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "docker") {
        if (args[1] === "--version") return done("Docker version29.9.1");
        if (args[1] === "context") return args[2] === "show" ? done("default") : done('{"Host":"unix:///run/docker.sock"}');
        if (args.includes("info")) return done("", 1);
        if (args.includes("compose")) return done("5.6.0");
      }
      if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/docker.sock") return done("1|500|socket\n");
      if (args[0] === "/usr/bin/systemctl" && args.includes("list-units")) return done("docker.socket loaded active listening Docker\n");
      if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "docker.socket") return done("Id=docker.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/docker.sock (Stream)\nTriggers=docker.service\n");
      if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "docker.service") return done("Id=docker.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n");
      throw new Error(`Unexpected APT service fixture operation ${args[0]}`);
    },
  }) });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed", sockets: ["docker.socket"], triggers: ["docker.service"] } } });
  expect(calls.some((args) => args.includes("info") || args.includes("compose") || args.includes("pull"))).toBe(false);
});

const aptPackages = {
  "docker-ce": "5:29.9.1-1~ubuntu.24.04~noble",
  "docker-ce-cli": "5:29.9.1-1~ubuntu.24.04~noble",
  "containerd.io": "2.4.2-2~ubuntu.24.04~noble",
  "docker-compose-plugin": "5.6.0-1~ubuntu.24.04~noble",
  "docker-buildx-plugin": "0.38.0-1~ubuntu.24.04~noble"
};
const aptArtifacts = {
  "docker-ce": {
    "name": "docker-ce",
    "version": "5:29.9.1-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "463a666215797c9f9ea7d0ad1751de5b2b3806a1b539a3550e16822ef34ccbfd",
    "size": 24548040,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce_29.9.1-1~ubuntu.24.04~noble_amd64.deb"
  },
  "docker-ce-cli": {
    "name": "docker-ce-cli",
    "version": "5:29.9.1-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "961968342af4738eb5fb5fc03f9834106c1e454bd010d574cf1a6feae9905efc",
    "size": 17593952,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce-cli_29.9.1-1~ubuntu.24.04~noble_amd64.deb"
  },
  "containerd.io": {
    "name": "containerd.io",
    "version": "2.4.2-2~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "7327ab23182425e94b46a91567e9ddf0183f9b3a5ed53d5e2489f000dbf9cfe2",
    "size": 23270672,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/containerd.io_2.4.2-2~ubuntu.24.04~noble_amd64.deb"
  },
  "docker-compose-plugin": {
    "name": "docker-compose-plugin",
    "version": "5.6.0-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "132266d499d9873aafcbe5b515997b8abd714914fa32a62ccac705c1ede7ca81",
    "size": 8079740,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-compose-plugin_5.6.0-1~ubuntu.24.04~noble_amd64.deb"
  },
  "docker-buildx-plugin": {
    "name": "docker-buildx-plugin",
    "version": "0.38.0-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "7094f8b50bc6b239292d475620424a531f7fa0763e466c52ffc3a4037e72bfc5",
    "size": 17783524,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~ubuntu.24.04~noble_amd64.deb"
  }
} as const;
const aptProfile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04" as const, architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: aptPackages, artifacts: aptArtifacts };
async function aptServiceFixture() {
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp("/tmp/fleur-apt-service-");
  const calls: string[][] = [];
  const prompts: string[] = [];
  const state = { active: false, containerdActive: true };
  const done = (stdout = "", exitCode = 0, stderr = ""): HostCommandResult => ({ status: "completed", exitCode, stdout, stderr });
  const hashes: Record<string, string> = { "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa", "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656", "containerd.service": "bd1effcf6d9cd564c232b631b353b2758f174160e3d8c078a792363b59f113d0" };
  const host = {
    stateDirectory: join(root, "state"), interactive: true,
    confirmHuman: async ({ action }: { action: string }) => { prompts.push(action); return "once" as const; },
    host: async () => ({ system: "linux", architecture: "x64", translated: false as const, distribution: "ubuntu", release: "24.04", machineId: "a".repeat(64) }),
    run: async (args: readonly string[]): Promise<HostCommandResult> => {
      calls.push([...args]);
      if (args[0] === "docker") {
        if (args[1] === "--version") return done("Docker version29.9.1");
        if (args[1] === "context") return args[2] === "show" ? done("default") : done('{"Host":"unix:///run/docker.sock"}');
        if (args.includes("info")) return state.active ? done('{"ServerVersion":"29.9.1","OSType":"linux","Architecture":"amd64"}') : done("", 1, "Cannot connect");
        if (args.includes("compose")) return done("5.6.0");
        if (args.includes("image")) return done("", 1, "No image");
      }
      if (args[0] === "dpkg-query") return done(Object.entries(aptPackages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n"));
      if (args[0] === "/usr/bin/dpkg-query" && args.includes("--search")) {
        const path = args.at(-1)!;
        return done(`${path.endsWith("containerd.service") ? "containerd.io" : path.endsWith("/systemctl") ? "systemd" : path.endsWith("/sudo") ? "sudo" : "docker-ce"}: ${path}\n`);
      }
      if (args[0] === "/usr/bin/readlink") return done(args.at(-1)!.replace(/^\/lib\//, "/usr/lib/")+"\n");
      if (args[0] === "/usr/bin/stat" && args.includes("--format=%d|%i|%F")) return state.active ? done("1|500|socket\n") : done("", 1, "No such file or directory");
      if (args[0] === "/usr/bin/stat") return done(`regular file|0|${args.at(-1) === "/usr/bin/sudo" ? "4755" : args.at(-1) === "/usr/bin/systemctl" ? "755" : "644"}|1\n`);
      if (args[0] === "/usr/bin/sha256sum") return done(`${hashes[args.at(-1)!.split("/").at(-1)!]}  ${args.at(-1)}\n`);
      if (args[0] === "/usr/bin/systemctl") {
        if (args.includes("is-active")) return done("active\n");
        if (args.includes("list-units")) return done("docker.socket loaded active listening Docker\n");
        const unit = args.at(-1)!;
        if (!Object.hasOwn(hashes, unit)) throw new Error("Unknown APT fixture unit");
        const active = state.active || (unit === "containerd.service" && state.containerdActive);
        const fields: Record<string, string> = { Id: unit, LoadState: "loaded", ActiveState: active ? "active" : "inactive", SubState: active ? unit.endsWith(".socket") ? "listening" : "running" : "dead", UnitFileState: "disabled", FragmentPath: `/usr/lib/systemd/system/${unit}`, DropInPaths: "", Transient: "no", NeedDaemonReload: "no", Job: "0", Wants: unit === "docker.service" ? "network-online.target containerd.service" : "", Requires: unit === "docker.service" ? "docker.socket sysinit.target system.slice" : unit === "containerd.service" ? "sysinit.target system.slice" : "sysinit.target", Requisite: "", BindsTo: "", Upholds: "", OnSuccess: "", OnFailure: "", CanStart: "yes", RefuseManualStart: "no", Listen: unit === "docker.socket" ? "/run/docker.sock (Stream)" : "", Triggers: unit === "docker.socket" ? "docker.service" : "" };
        const requested = args.find((arg) => arg.startsWith("--property="))?.slice(11).split(",");
        if (!requested || requested.some((key) => !Object.hasOwn(fields, key))) throw new Error("Unknown APT fixture properties");
        return done(requested.map((key) => `${key}=${fields[key]}`).join("\n"));
      }
      if (args[0] === "/usr/bin/sudo") { state.active = true; state.containerdActive = true; return done(); }
      throw new Error(`Unexpected APT service fixture operation ${args[0]}`);
    },
  };
  return { root, host, calls, prompts, state, handlers: setupCommands(host, [aptProfile]) };
}
test("exact installed APT packages offer separate startup authority while preserving active containerd", async () => {
  const fixture = await aptServiceFixture();
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ plan: { action: "service-start", method: "docker-official-apt" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args.includes("start") || args.includes("install") || args.includes("enable"))).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

// Scope audit: unchanged vendor pre-start belongs to the declared service-start action.
test("cold APT containerd starts with only its matching service-start authority and declares vendor pre-start effects", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.containerdActive = false;
  try {
    const plan = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(plan.result.data).toMatchObject({ plan: { action: "service-start", prestartEffects: { unit: "containerd.service", command: "-/sbin/modprobe overlay" } } });
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(fixture.prompts).toEqual(["service-start"]);
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "service-start", state: "completed" } });
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "--system", "--no-ask-password", "--job-mode=fail", "start", "docker.service"]]);
    expect(fixture.calls.some((args) => args[0]?.endsWith("modprobe") || args.includes("enable") || args.includes("restart") || args.includes("usermod"))).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a separate APT startup grant starts only the declared vendor service and preserves boot/access configuration", async () => {
  const fixture = await aptServiceFixture();
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(fixture.prompts).toEqual(["service-start"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "--system", "--no-ask-password", "--job-mode=fail", "start", "docker.service"]]);
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "service-start", state: "completed" } });
    expect(fixture.calls.some((args) => args.includes("enable") || args.includes("restart") || args.includes("usermod") || args.includes("daemon-reload") || args.includes("pull"))).toBe(false);
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "service-start", method: "docker-official-apt", revoked: true }] });
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});
for (const mode of ["timeout", "truncated"] as const) test(`APT service ${mode} completion preserves recovery and prevents daemon RPC or blind retry`, async () => {
  const fixture = await aptServiceFixture();
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    if (args[0] === "/usr/bin/sudo") {
      fixture.calls.push([...args]); fixture.state.active = true;
      return mode === "timeout" ? { status: "timeout", stdout: "", stderr: "" } : { status: "completed", exitCode: 0, stdout: "", stderr: "", terminationUnconfirmed: true };
    }
    return run(args);
  };
  try {
    expect((await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(5);
    const count = fixture.calls.length;
    const retry = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(retry.exitCode).toBe(5);
    expect(retry.result.error?.code).toBe("RECOVERY_REQUIRED");
    expect(fixture.calls.slice(count).some((args) => args.includes("info") || args.includes("start") || args.includes("pull"))).toBe(false);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

for (const mode of ["unit-digest", "unit-owner", "path-alias", "drop-in", "dependency", "package-health"] as const) test(`APT startup preserves ${mode} mismatch without authority or service effects`, async () => {
  const fixture = await aptServiceFixture();
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    if (mode === "unit-digest" && args[0] === "/usr/bin/sha256sum") return { ...result, stdout: result.stdout.replace(/^[a-f0-9]{64}/, "0".repeat(64)) };
    if (mode === "unit-owner" && args[0] === "/usr/bin/dpkg-query" && args.at(-1)?.endsWith("containerd.service")) return { ...result, stdout: result.stdout.replace("containerd.io:", "foreign-package:") };
    if (mode === "path-alias" && args[0] === "/usr/bin/readlink" && args.at(-1)?.startsWith("/lib/")) return { ...result, stdout: "/etc/custom-containerd.service\n" };
    if (mode === "drop-in" && args[0] === "/usr/bin/systemctl") return { ...result, stdout: result.stdout.replace("DropInPaths=\n", "DropInPaths=/etc/systemd/system/docker.service.d/custom.conf\n") };
    if (mode === "dependency" && args[0] === "/usr/bin/systemctl") return { ...result, stdout: result.stdout.replace("Wants=network-online.target containerd.service", "Wants=network-online.target containerd.service unknown.service") };
    if (mode === "package-health" && args[0] === "dpkg-query" && args.at(-1)?.includes("${db:Status-Eflag}")) return { ...result, stdout: result.stdout + "unrelated\t1\thalf-configured\tok\n" };
    return result;
  };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.result.ok).toBe(false);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("APT startup rejects package drift during confirmation without consuming unused once authority", async () => {
  const fixture = await aptServiceFixture();
  let changed = false;
  const run = fixture.host.run;
  const host = { ...fixture.host, confirmHuman: async () => { changed = true; return "once" as const; }, run: async (args: readonly string[]) => {
    const result = await run(args);
    return changed && args[0] === "dpkg-query" ? { ...result, stdout: result.stdout.replace(aptPackages["docker-ce"], "99") } : result;
  } };
  try {
    const handlers = setupCommands(host, [aptProfile]);
    expect((await runCli(["setup"], { cwd: fixture.root, handlers })).exitCode).toBe(3);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "service-start", revoked: false }] });
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("an unrelated explicit APT grant cannot start a service or open another prompt", async () => {
  const fixture = await aptServiceFixture();
  try {
    const outcome = await runCli(["setup", "--grant", "00000000-0000-0000-0000-000000000000"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("an independent standard-socket APT daemon remains reusable after a complete unrelated activation inventory", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    if (args[0] === "/usr/bin/systemctl" && args.includes("list-units")) { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout: "other.socket loaded active listening Other\n", stderr: "" }; }
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "other.socket") { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout: "Id=other.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/other.sock (Stream)\nTriggers=other.service\n", stderr: "" }; }
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/other.sock") { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout: "1|600|socket\n", stderr: "" }; }
    return run(args);
  };
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ plan: { action: "image-acquire" } });
    expect(fixture.calls.some((args) => args.includes("other.socket"))).toBe(true);
    expect(fixture.calls.some((args) => args.includes("info"))).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || args[0] === "dpkg-query")).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});
for (const mode of ["unknown", "truncated"] as const) test(`APT ${mode} activation inventory cannot fall into installation, access or service startup`, async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    return args.includes("list-units") ? mode === "unknown" ? { ...result, stdout: "unparseable inventory" } : { ...result, terminationUnconfirmed: true } : result;
  };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-unknown" } } });
    expect(fixture.calls.some((args) => args.includes("info") || args[0] === "/usr/bin/sudo" || args[0] === "dpkg-query")).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("APT startup accepts a verified standard socket alias without changing endpoint selection", async () => {
  const fixture = await aptServiceFixture();
  const run = fixture.host.run;
  const host = { ...fixture.host, environment: { DOCKER_HOST: "unix:///var/run/docker.sock" }, run: async (args: readonly string[]) => {
    if (args[0] === "/usr/bin/readlink" && args.at(-1) === "/var/run") { fixture.calls.push([...args]); return { status: "completed" as const, exitCode: 0, stdout: "/run\n", stderr: "" }; }
    return run(args);
  } };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(host, [aptProfile]) });
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "service-start", state: "completed" } });
    expect(fixture.calls.some((args) => args.includes("info") && args.includes("unix:///var/run/docker.sock"))).toBe(true);
    expect(fixture.calls.some((args) => args.includes("context") && args.includes("use"))).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("an existing rootless APT endpoint is reused without system-unit conversion", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const host = { ...fixture.host, environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" } };
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: setupCommands(host, [aptProfile]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ plan: { action: "image-acquire" } });
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/systemctl" || args[0] === "/usr/bin/sudo" || args[0] === "dpkg-query")).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

for (const mode of ["install-only", "revoked", "other-machine"] as const) test(`APT ${mode} authority cannot cover the concrete startup plan`, async () => {
  const fixture = await aptServiceFixture();
  try {
    const plan = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    const { checksum, target } = (plan.result.data as { plan: { checksum: string; target: string } }).plan;
    const id = "00000000-0000-0000-0000-000000000001";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${fixture.host.stateDirectory}/grants.json`, JSON.stringify({ formatVersion: 1, grants: [{ id, action: mode === "install-only" ? "install" : "service-start", method: "docker-official-apt", target, planChecksum: checksum, machine: mode === "other-machine" ? "b".repeat(64) : "a".repeat(64), user: process.getuid!(), mode: "remembered", revoked: mode === "revoked" }] }), { mode: 0o600 });
    const outcome = await runCli(["setup", "--grant", id], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("APT OS authentication refusal consumes once authority without pretending startup or replaying it", async () => {
  const fixture = await aptServiceFixture();
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    if (args[0] === "/usr/bin/sudo") { fixture.calls.push([...args]); return { status: "completed", exitCode: 1, stdout: "", stderr: "sudo: a password is required\n" }; }
    return run(args);
  };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("HUMAN_ACTION_REQUIRED");
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "service-start", revoked: true }] });
    expect((await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(3);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("APT startup requires durable pending parent state before privilege and retains recovery after durability failure", async () => {
  const fixture = await aptServiceFixture();
  const host = { ...fixture.host, syncDirectory: async () => {
    const { lstat } = await import("node:fs/promises");
    const pending = await lstat(`${fixture.host.stateDirectory}/apt-service-start-pending.json`).then(() => true).catch(() => false);
    if (pending) throw new Error("Fixture pending-parent sync failed");
  } };
  try {
    const handlers = setupCommands(host, [aptProfile]);
    expect((await runCli(["setup"], { cwd: fixture.root, handlers })).exitCode).toBe(5);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect((await runCli(["setup", "--json"], { cwd: fixture.root, handlers })).exitCode).toBe(5);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a terminal APT start exit alone cannot replace actual cold-containerd service activation proof", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.containerdActive = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    if (args[0] === "/usr/bin/sudo") { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; }
    return run(args);
  };
  try {
    expect((await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(5);
    expect(fixture.prompts).toEqual(["service-start"]);
    expect((await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(5);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("interactive APT startup discloses named units and vendor pre-start effects before human consent", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.containerdActive = false;
  let target = "";
  const host = { ...fixture.host, confirmHuman: async (plan: { readonly target: string }) => { target = plan.target; return "deny" as const; } };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(host, [aptProfile]) });
    expect(outcome.exitCode).toBe(3);
    expect(target).toContain("docker.service");
    expect(target).toContain("containerd.service");
    expect(target).toContain("docker.socket");
    expect(target).toContain("-/sbin/modprobe overlay");
    expect(target).toContain("may load the overlay kernel module");
    expect(target.length).toBeLessThanOrEqual(512);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("an unrelated cloud-init FIFO listener does not block passive Docker readiness", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const done = (stdout: string): HostCommandResult => { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout, stderr: "" }; };
    if (args[0] === "/usr/bin/systemctl" && args.includes("list-units")) return done("cloud-init-hotplugd.socket loaded active listening cloud-init\n");
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "cloud-init-hotplugd.socket") return done("Id=cloud-init-hotplugd.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/cloud-init/share/hook-hotplug-cmd (FIFO)\nTriggers=cloud-init-hotplugd.service\n");
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/cloud-init/share/hook-hotplug-cmd") return done("1|600|fifo\n");
    return run(args);
  };
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" }, smoke: { state: "image-required" } } });
    expect(fixture.calls.some((args) => args.includes("info"))).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a running activation socket with an already running Docker service permits passive readiness", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    return args[0] === "/usr/bin/systemctl" && args.at(-1) === "docker.socket" ? { ...result, stdout: result.stdout.replace("SubState=listening", "SubState=running") } : result;
  };
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" }, smoke: { state: "image-required" } } });
    expect(fixture.calls.some((args) => args.includes("info"))).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

for (const mode of ["socket-behind-fifo", "same-identity", "unavailable", "malformed", "unknown-kind", "unknown-relative-kind", "selected-fifo"] as const) test(`inconsistent ${mode} activation evidence blocks setup without daemon RPC`, async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const done = (stdout: string, exitCode = 0, stderr = ""): HostCommandResult => { fixture.calls.push([...args]); return { status: "completed", exitCode, stdout, stderr }; };
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/docker.sock" && mode === "selected-fifo") return done("1|500|fifo\n");
    if (args[0] === "/usr/bin/systemctl" && args.includes("list-units")) return done("other.socket loaded active listening Other\n");
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "other.socket") return done(`Id=other.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=${mode === "unknown-relative-kind" ? "9000" : "/run/other.fifo"} (${mode === "unknown-kind" || mode === "unknown-relative-kind" ? "Unreviewed" : "FIFO"})\nTriggers=other.service\n`);
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/other.fifo") {
      expect(args).toContain("--dereference");
      if (mode === "socket-behind-fifo") return done("1|600|socket\n");
      if (mode === "same-identity") return done("0001|500|fifo\n");
      if (mode === "unavailable") return done("", 1, "Permission denied");
      if (mode === "malformed") return done("1|600|regular file\n");
      return done("1|600|fifo\n");
    }
    return run(args);
  };
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-unknown" } } });
    expect(fixture.calls.some((args) => args.includes("info") || args[0] === "/usr/bin/sudo" || args[0] === "dpkg-query")).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("an unrelated FIFO cannot hide a later running socket alias with a stopped activation target", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const done = (stdout: string): HostCommandResult => { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout, stderr: "" }; };
    if (args[0] === "/usr/bin/systemctl" && args.includes("list-units")) return done("other.socket loaded active listening Other\ncustom.socket loaded active running Custom\n");
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "other.socket") return done("Id=other.socket\nLoadState=loaded\nActiveState=active\nSubState=listening\nListen=/run/other.fifo (FIFO)\nTriggers=other.service\n");
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "custom.socket") return done("Id=custom.socket\nLoadState=loaded\nActiveState=active\nSubState=running\nListen=/run/alias.sock (Stream)\nTriggers=custom.service\n");
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "custom.service") return done("Id=custom.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n");
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/other.fifo") return done("1|600|fifo\n");
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/alias.sock") return done("0001|500|socket\n");
    return run(args);
  };
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed", sockets: ["custom.socket"], triggers: ["custom.service"] } } });
    expect(fixture.calls.some((args) => args.includes("custom.service"))).toBe(true);
    expect(fixture.calls.some((args) => args.includes("info") || args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});

test("an unrelated running socket remains compatible with an already running Docker daemon", async () => {
  const fixture = await aptServiceFixture();
  fixture.state.active = true;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const done = (stdout: string): HostCommandResult => { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stdout, stderr: "" }; };
    if (args[0] === "/usr/bin/systemctl" && args.includes("list-units")) return done("other.socket loaded active running Other\n");
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "other.socket") return done("Id=other.socket\nLoadState=loaded\nActiveState=active\nSubState=running\nListen=/run/other.sock (Stream)\nTriggers=other.service\n");
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/other.sock") return done("1|600|socket\n");
    return run(args);
  };
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.result.data).toMatchObject({ plan: { action: "image-acquire" } });
    expect(fixture.calls.some((args) => args.includes("info"))).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { const { rm } = await import("node:fs/promises"); await rm(fixture.root, { recursive: true, force: true }); }
});
