import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type HostCommandResult, type SetupHost } from "../../src/setup/commands.ts";
const packages = {
  docker: { version: "1:29.9.0-1", url: "https://archive.archlinux.org/packages/d/docker/docker-1:29.9.0-1-x86_64.pkg.tar.zst", sha256: "3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54", size: 50000000, signature: "c2lnbmF0dXJl", signer: "2E36D8620221482FC45CB7F2A91764759326B440" },
  "docker-compose": { version: "5.6.0-1", url: "https://archive.archlinux.org/packages/d/docker-compose/docker-compose-5.6.0-1-x86_64.pkg.tar.zst", sha256: "152ccc5e901b5a9ea2d53e29b8ad7b8ec736c9da75bbd224dc472a407578690d", size: 50000000, signature: "c2lnbmF0dXJl", signer: "601F20F1D1BBBF4A78CF5B6DF6B1610B3ECDBC9F" },
  containerd: { version: "2.4.1-1", url: "https://archive.archlinux.org/packages/c/containerd/containerd-2.4.1-1-x86_64.pkg.tar.zst", sha256: "c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999", size: 50000000, signature: "c2lnbmF0dXJl", signer: "262A58EC6C51F7EA395B2E2DFDC3040B92ACA748" },
  runc: { version: "1.5.2-1", url: "https://archive.archlinux.org/packages/r/runc/runc-1.5.2-1-x86_64.pkg.tar.zst", sha256: "b204e74bba04c491d0bd71f8b5adefff538bbfc516d199bdb1a1513959977dd3", size: 50000000, signature: "c2lnbmF0dXJl", signer: "05C7775A9E8B977407FE08E69D4C5AA15426DA0A" },
};
const profile = { method: "arch-official-pacman" as const, verified: true as const, distribution: "arch" as const, release: "rolling" as const, architecture: "x64" as const, snapshot: "2026-10-12" as const, packages };

const unitHashes: Record<string, string> = {
  "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa",
  "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656",
  "containerd.service": "7522a4e33c633f22fc0049d3c075b552f7df30cd978acd0175b972bdebc922ea",
};
async function serviceFixture() {
  const root = await mkdtemp("/tmp/fleur-arch-service-");
  const calls: string[][] = [];
  const prompts: string[] = [];
  const state = { active: false, socketListening: false, manualDaemon: false, upholds: "", packageDrift: false };
  const done = (stdout = "", exitCode = 0, stderr = ""): HostCommandResult => ({ status: "completed", stdout, exitCode, stderr });
  const host: SetupHost = {
    stateDirectory: join(root, "state"), interactive: true,
    confirmHuman: async ({ action }) => { prompts.push(action); return "once"; },
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "rolling", distribution: "arch", machineId: "a".repeat(64) }),
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "/usr/bin/stat" && args.at(-1) === "/var/lib/pacman/db.lck") return done("", 1, "No such file or directory");
      if (args[0] === "/usr/bin/pacman" && args.includes("--database")) return done();
      if (args[0] === "docker") {
        if (args[1] === "--version") return done("Docker version29.9.0");
        if (args[1] === "context") return args[2] === "show" ? done("default\n") : done('{"Host":"unix:///run/docker.sock"}');
        if (args.includes("compose")) return done("5.6.0\n");
        if (args.includes("info")) return state.active || state.manualDaemon ? done('{"ServerVersion":"29.9.0","OSType":"linux","Architecture":"amd64"}') : done("", 1, "Cannot connect to Docker daemon");
        if (args.includes("image")) return done("", 1, "No image");
      }
      if (args[0] === "pacman") return args.includes("--query") ? done(Object.entries(packages).map(([name, value]) => `${name} ${value.version}\n`).join("")) : done();
      if (args[0] === "stat" && args.at(-1) === "/var/lib/pacman/db.lck") return done("", 1, "No such file or directory");
      if (args[0] === "/usr/bin/stat" && args.includes("--format=%d|%i|%F")) {
        const path = args.at(-1)!;
        if (path === "/run/unrelated.sock") return done("1|600|socket\n");
        if (path === "/run/docker.sock") return state.active || state.socketListening || state.manualDaemon ? done("1|500|socket\n") : done("", 1, "No such file or directory");
        throw new Error("Unexpected passive socket path");
      }
      if (args[0] === "/usr/bin/stat") return done(`regular file|0|${args.at(-1) === "/usr/bin/sudo" ? "4755" : args.at(-1)?.startsWith("/usr/bin/") ? "755" : "644"}|1\n`);
      if (args[0] === "/usr/bin/sha256sum") { const path = args.at(-1)!; return done(`${unitHashes[path.split("/").at(-1)!]}  ${path}\n`); }
      if (args[0] === "/usr/bin/pacman" && !args.includes("--owns")) return done(Object.entries(packages).map(([name, value]) => `${name} ${name === "docker" && state.packageDrift ? "0.1.0" : value.version}`).join("\n"));
      if (args[0] === "/usr/bin/pacman") return done(args.at(-1)?.includes("containerd") ? "containerd\n" : args.at(-1) === "/usr/bin/systemctl" ? "systemd\n" : args.at(-1) === "/usr/bin/sudo" ? "sudo\n" : "docker\n");
      if (args[0] === "/usr/bin/systemctl") {
        if (args.includes("is-active")) return done("active\n");
        if (args.includes("list-units")) return done("docker.socket loaded inactive dead Docker\nunrelated.socket loaded active listening Unrelated\n");
        const unit = args.find((arg) => Object.hasOwn(unitHashes, arg) || ["unrelated.socket", "unrelated.service"].includes(arg));
        if (!unit) throw new Error("Unknown fixture unit");
        const active = unit.startsWith("unrelated.") || state.active || (unit === "docker.socket" && state.socketListening);
        const values: Record<string, string> = { Id: unit, Upholds: unit === "docker.service" ? state.upholds : "", Requisite: "", BindsTo: "", OnSuccess: "", OnFailure: "", CanStart: "yes", RefuseManualStart: "no", LoadState: "loaded", ActiveState: active ? "active" : "inactive", SubState: active ? unit.endsWith(".socket") ? "listening" : "running" : "dead", UnitFileState: "disabled", FragmentPath: `/usr/lib/systemd/system/${unit}`, DropInPaths: "", Transient: "no", NeedDaemonReload: "no", Job: "0", Wants: unit === "docker.service" ? "network-online.target containerd.service" : "", Requires: unit === "docker.service" ? "docker.socket sysinit.target system.slice" : unit === "containerd.service" ? "sysinit.target system.slice" : "sysinit.target", Listen: unit === "docker.socket" ? "/run/docker.sock (Stream)" : unit === "unrelated.socket" ? "/run/unrelated.sock (Stream)" : "", Triggers: unit === "docker.socket" ? "docker.service" : unit === "unrelated.socket" ? "unrelated.service" : "" };
        const requested = args.find((arg) => arg.startsWith("--property="))?.slice(11).split(",");
        return done(Object.entries(values).filter(([key]) => !requested || requested.includes(key)).map(([key, value]) => `${key}=${value}`).join("\n"));
      }
      if (args[0] === "/usr/bin/sudo") { state.active = true; return done(); }
      throw new Error(`Unexpected service fixture operation ${args[0]}`);
    },
  };
  return { root, calls, prompts, state, host, handlers: setupCommands(host, [profile]) };
}
test("stopped Arch Docker offers a concrete service-start grant without installing or enabling anything", async () => {
  const fixture = await serviceFixture();
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ plan: { action: "service-start", method: "arch-official-pacman", endpoint: "unix:///run/docker.sock", units: ["docker.service", "docker.socket", "containerd.service"] }, resumable: true });
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || args.includes("--upgrade") || args.includes("enable"))).toBe(false);
    expect(fixture.prompts).toEqual([]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a separately granted Arch service start runs once and reprobes without enabling or changing membership", async () => {
  const fixture = await serviceFixture();
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(fixture.prompts).toEqual(["service-start"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "--system", "--no-ask-password", "--job-mode=fail", "start", "docker.service"]]);
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "service-start", state: "completed" }, resumable: true });
    expect(outcome.exitCode).toBe(3);
    expect(fixture.calls.some((args) => args.includes("enable") || args.includes("restart") || args.includes("usermod") || args.includes("daemon-reload") || args.includes("pull"))).toBe(false);
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "service-start", revoked: true }] });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("doctor never connects to a listening activation socket whose Docker service is stopped", async () => {
  const fixture = await serviceFixture();
  fixture.state.socketListening = true;
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed", sockets: ["docker.socket"], triggers: ["docker.service"] } } });
    expect(fixture.calls.some((args) => args[0] === "docker" && args.includes("info"))).toBe(false);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a manually managed standard-socket daemon remains reusable after complete passive activation inventory", async () => {
  const fixture = await serviceFixture();
  fixture.state.manualDaemon = true;
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" }, smoke: { state: "image-required" } } });
    expect(fixture.calls.some((args) => args.includes("list-units"))).toBe(true);
    expect(fixture.calls.some((args) => args.includes("unrelated.socket"))).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/stat" && args.at(-1) === "/run/unrelated.sock")).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "docker" && args.includes("info"))).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("unknown activation inventory blocks setup rather than falling through to default system startup", async () => {
  const fixture = await serviceFixture();
  fixture.state.socketListening = true;
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number) => {
    const result = await run(args, budget);
    return args.includes("list-units") ? { ...result, stdout: "malformed inventory" } : result;
  } };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-unknown" } } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || (args[0] === "docker" && args.includes("info")))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("activation ownership drift while granting startup prevents privileged dispatch and preserves unused once authority", async () => {
  const fixture = await serviceFixture();
  fixture.state.socketListening = true;
  let changed = false;
  const run = fixture.host.run;
  const host = { ...fixture.host,
    confirmHuman: async () => { changed = true; return "once" as const; },
    run: async (args: readonly string[], budget: number) => {
      const result = await run(args, budget);
      return changed && args.includes("list-units") ? { ...result, stdout: "malformed changed inventory" } : result;
    },
  };
  try {
    const handlers = setupCommands(host, [profile]);
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers });
    expect(outcome.exitCode).toBe(4);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "service-start", revoked: false }] });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("unconfirmed privileged completion keeps a fence even if the daemon becomes usable and blocks retry effects", async () => {
  const fixture = await serviceFixture();
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number) => {
    const result = await run(args, budget);
    return args[0] === "/usr/bin/sudo" ? { ...result, terminationUnconfirmed: true } : result;
  } };
  try {
    const handlers = setupCommands(host, [profile]);
    const first = await runCli(["setup"], { cwd: fixture.root, handlers });
    expect(first.exitCode).toBe(5);
    const retry = await runCli(["setup", "--json"], { cwd: fixture.root, handlers });
    expect(retry.exitCode).toBe(5);
    expect(retry.result.error?.code).toBe("RECOVERY_REQUIRED");
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
    expect(await Bun.file(join(fixture.host.stateDirectory!, "arch-service-start-pending.json")).exists()).toBe(true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("unreviewed loaded activation dependencies cannot hide outside Wants and Requires", async () => {
  const fixture = await serviceFixture();
  fixture.state.upholds = "foreign.service";
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const mode of ["masked", "drop-in", "digest", "dependency"] as const) test(`Arch service startup preserves ${mode} configuration without requesting authority`, async () => {
  const fixture = await serviceFixture();
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number) => {
    const result = await run(args, budget);
    if (args[0] === "/usr/bin/sha256sum" && mode === "digest") return { ...result, stdout: result.stdout.replace(/^[a-f0-9]{64}/, "0".repeat(64)) };
    if (args[0] === "/usr/bin/systemctl" && args.includes("docker.service")) {
      const replacement = mode === "masked" ? ["LoadState=loaded", "LoadState=masked"] : mode === "drop-in" ? ["DropInPaths=", "DropInPaths=/etc/systemd/system/docker.service.d/custom.conf"] : mode === "dependency" ? ["Wants=network-online.target containerd.service", "Wants=foreign.service containerd.service network-online.target"] : undefined;
      if (replacement) return { ...result, stdout: result.stdout.replace(replacement[0]!, replacement[1]!) };
    }
    return result;
  } };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.exitCode).toBe(3);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || args.includes("enable") || args.includes("unmask") || args.includes("daemon-reload"))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("pending-fence directory durability failure prevents service dispatch and blocks retry", async () => {
  const fixture = await serviceFixture();
  const host = { ...fixture.host, syncDirectory: async (path: string) => {
    if (await Bun.file(join(path, "arch-service-start-pending.json")).exists()) throw Object.assign(new Error("Injected directory EIO"), { code: "EIO" });
  } };
  try {
    const handlers = setupCommands(host, [profile]);
    expect((await runCli(["setup"], { cwd: fixture.root, handlers })).exitCode).toBe(5);
    expect((await runCli(["setup", "--json"], { cwd: fixture.root, handlers })).exitCode).toBe(5);
    expect(await Bun.file(join(fixture.host.stateDirectory!, "arch-service-start-pending.json")).exists()).toBe(true);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const mode of ["timeout", "auth"] as const) test(`Arch service ${mode} failure never enables, kills or silently retries`, async () => {
  const fixture = await serviceFixture();
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number): Promise<HostCommandResult> => {
    if (args[0] === "/usr/bin/sudo") { fixture.calls.push([...args]); return mode === "timeout" ? { status: "timeout", stdout: "", stderr: "" } : { status: "completed", exitCode: 1, stdout: "", stderr: "sudo: a password is required\n" }; }
    return run(args, budget);
  } };
  try {
    const handlers = setupCommands(host, [profile]);
    const first = await runCli(["setup"], { cwd: fixture.root, handlers });
    expect(first.exitCode).toBe(mode === "timeout" ? 5 : 3);
    const retry = await runCli(["setup", "--json"], { cwd: fixture.root, handlers });
    expect(retry.exitCode).toBe(mode === "timeout" ? 5 : 3);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
    expect(fixture.calls.some((args) => ["enable", "unmask", "stop", "kill", "restart"].some((word) => args.includes(word)))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a package version changing during startup authorization invalidates the service plan", async () => {
  const fixture = await serviceFixture();
  const host = { ...fixture.host, confirmHuman: async () => { fixture.state.packageDrift = true; return "once" as const; } };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.exitCode).toBe(3);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const mode of ["non-socket", "contradictory", "truncated"] as const) test(`passive activation ${mode} data never authorizes daemon RPC`, async () => {
  const fixture = await serviceFixture();
  fixture.state.manualDaemon = true;
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number) => {
    const result = await run(args, budget);
    if (mode === "non-socket" && args.includes("--format=%d|%i|%F") && args.at(-1) === "/run/docker.sock") return { ...result, stdout: "1|500|regular file\n" };
    if (mode === "contradictory" && args.includes("docker.socket") && args.some((arg) => arg.includes("Listen"))) return { ...result, stdout: result.stdout.replace("SubState=dead", "SubState=listening") };
    if (mode === "truncated" && args.includes("list-units")) return { ...result, terminationUnconfirmed: true };
    return result;
  } };
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-unknown" } } });
    expect(fixture.calls.some((args) => args[0] === "docker" && args.includes("info"))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("passive ownership matches an activation socket alias by actual device and inode", async () => {
  const fixture = await serviceFixture();
  fixture.state.socketListening = true;
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number) => {
    if (args[0] === "/usr/bin/stat" && args.at(-1) === "/run/alias.sock") { fixture.calls.push([...args]); return { status: "completed" as const, exitCode: 0, stdout: "1|500|socket\n", stderr: "" }; }
    const result = await run(args, budget);
    return args.includes("docker.socket") && args.some((arg) => arg.includes("Listen")) ? { ...result, stdout: result.stdout.replace("Listen=/run/docker.sock", "Listen=/run/alias.sock") } : result;
  } };
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.result.data).toMatchObject({ components: { service: { state: "activation-needed" } } });
    expect(fixture.calls.some((args) => args[0] === "docker" && args.includes("info"))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a custom activation owner is preserved rather than authorized as the default Docker unit", async () => {
  const fixture = await serviceFixture();
  fixture.state.socketListening = true;
  const run = fixture.host.run;
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number): Promise<HostCommandResult> => {
    if (args.includes("list-units")) { fixture.calls.push([...args]); return { status: "completed", exitCode: 0, stderr: "", stdout: "custom.socket loaded active listening Custom\n" }; }
    if (args.includes("custom.socket") || args.includes("custom.service")) {
      fixture.calls.push([...args]);
      const socket = args.includes("custom.socket");
      return { status: "completed", exitCode: 0, stderr: "", stdout: `Id=custom.${socket ? "socket" : "service"}\nLoadState=loaded\nActiveState=${socket ? "active" : "inactive"}\nSubState=${socket ? "listening" : "dead"}\n${socket ? "Listen=/run/docker.sock (Stream)\nTriggers=custom.service\n" : ""}` };
    }
    return run(args, budget);
  } };
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.exitCode).toBe(4);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || (args[0] === "docker" && args.includes("info")))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a compatible rootless local endpoint is not converted into a system service action", async () => {
  const fixture = await serviceFixture();
  fixture.state.manualDaemon = true;
  const run = fixture.host.run;
  const endpoint = "unix:///run/user/1000/docker.sock";
  const host = { ...fixture.host, run: async (args: readonly string[], budget: number) => {
    const result = await run(args, budget);
    return args[0] === "docker" && args[1] === "context" && args[2] === "inspect" ? { ...result, stdout: JSON.stringify({ Host: endpoint }) } : result;
  } };
  try {
    const outcome = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: setupCommands(host, [profile]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ components: { daemon: { state: "ready" } } });
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/systemctl" || args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.calls.some((args) => args[0] === "docker" && args.includes("info") && args.includes(endpoint))).toBe(true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("an unrelated explicit grant cannot authorize service startup or open another prompt", async () => {
  const fixture = await serviceFixture();
  try {
    const outcome = await runCli(["setup", "--grant", "00000000-0000-0000-0000-000000000000"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(outcome.exitCode).toBe(3);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("revoked service authority cannot replay on a later unchanged setup", async () => {
  const fixture = await serviceFixture();
  fixture.state.socketListening = true;
  let changed = false;
  const run = fixture.host.run;
  const host = { ...fixture.host, confirmHuman: async () => { changed = true; return "once" as const; }, run: async (args: readonly string[], budget: number) => {
    const result = await run(args, budget);
    return changed && args.includes("list-units") ? { ...result, stdout: "malformed drift" } : result;
  } };
  try {
    const handlers = setupCommands(host, [profile]);
    expect((await runCli(["setup"], { cwd: fixture.root, handlers })).exitCode).toBe(4);
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers });
    const id = (listed.result.data as { grants: { id: string }[] }).grants[0]!.id;
    expect((await runCli(["setup", "grants", "revoke", id, "--json"], { cwd: fixture.root, handlers })).exitCode).toBe(0);
    changed = false;
    expect((await runCli(["setup", "--json"], { cwd: fixture.root, handlers })).exitCode).toBe(3);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
