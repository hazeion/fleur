import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SetupHost } from "../../src/setup/commands.ts";

type FixtureContainer = { Id: string; Name: string; Image: string; Mounts: unknown[]; Config: Record<string, unknown>; HostConfig: Record<string, unknown>; State: { Running: boolean; Pid: number } };
async function scenario(mode: "source-race" | "uncertain-start" | "ownership-drift" | "native-absence" | "native-manager-label", candidate?: string, platform = "Docker Desktop 4.96.1 (244132)", compose = "5.6.1", tuple: { release?: string; cli?: Record<string, unknown>; components?: unknown[]; security?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-desktop-control-review-"));
  const repository = resolve(import.meta.dir, "../..");
  try {
    await cp(join(repository, "src"), join(directory, "src"), { recursive: true });
    await mkdir(join(directory, "scripts"));
    for (const name of ["observe-desktop-control.ts", "desktop-control-probe.ts"]) await cp(join(repository, "scripts", name), join(directory, "scripts", name));
    await cp(join(repository, "package.json"), join(directory, "package.json"));
    const originalProgram = await readFile(join(directory, "scripts/desktop-control-probe.ts"), "utf8");
    const { observeDesktopControl } = await import(join(directory, "scripts/observe-desktop-control.ts"));
    const image = `sha256:${"c".repeat(64)}`;
    const states = new Map<string, FixtureContainer>(); const names = new Map<string, string>(); const removed: string[] = []; const managerPrograms: string[] = [];
    let created = 0; let managerLogged = false;
    const done = (stdout = "", exitCode = 0, stderr = "") => ({ status: "completed" as const, stdout, stderr, exitCode });
    const host: SetupHost = {
      environment: { DOCKER_HOST: "unix:///private/controlled-desktop.sock" },
      host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: tuple.release ?? "15.7.7" }),
      run: async (input) => {
        const args = [...input];
        if (args[0] === "git") {
          if (args[1] === "rev-parse") return done(`${"a".repeat(40)}\n`);
          if (args[1] === "diff") return done();
          if (args[1] === "show") return done(await readFile(join(directory, args[2]!.split(":").slice(1).join(":")), "utf8"));
        }
        if (args[0] !== "docker") throw new Error("Unexpected controlled command");
        if (args[1] === "context") return done("desktop-linux\n");
        const command = args[3];
        if (command === "version" && args.at(-1) === "{{json .Client}}") return done(JSON.stringify(tuple.cli ?? { Version: "29.9.2", GitCommit: "a82e528", Os: "darwin", Arch: "amd64" }));
        if (command === "version") return done(JSON.stringify({ Components: tuple.components ?? [{ Name: "Engine", Version: "29.9.2", Details: { GitCommit: "0367cbe" } }, { Name: "containerd", Version: "v2.4.2", Details: { GitCommit: "b7a25261e029d68978bbf290df0a62fc819b3c51" } }, { Name: "runc", Version: "1.5.2", Details: { GitCommit: "v1.5.2-0-g29dd3dc2" } }], Platform: { Name: platform }, Version: "29.9.2", GitCommit: "0367cbe", Os: "linux", Arch: "amd64", KernelVersion: "7.0.14-linuxkit" }));
        if (command === "compose") return done(compose + "\n");
        if (command === "info" && args.at(-1) === "{{json .CgroupDriver}}|{{json .CgroupVersion}}|{{json .SecurityOptions}}") return done(tuple.security ?? '"cgroupfs"|"2"|["name=seccomp,profile=builtin","name=cgroupns"]\n');
        if (command === "info") return done('"fixed-daemon"|"29.9.2"|"7.0.14-linuxkit"|"x86_64"|"cgroupfs"|"2"\n');
        if (command === "ps") return done([...states.keys()].sort().join("\n"));
        if (command === "image") return args[4] === "inspect" ? done(JSON.stringify([{ Id: image, Architecture: "amd64", Os: "linux", Config: { Volumes: null } }])) : done(`${image}\n`);
        if (command === "inspect") {
          const target = args[4]!; const value = states.get(target) ?? states.get(names.get(target) ?? "");
          if (!value) return mode === "native-absence" ? done("\n", 1, `error: no such object: ${target}\n`) : done("", 1, `Error: No such object: ${target}\n`);
          if (mode === "ownership-drift" && managerLogged && value.Config.User === "65534:65534") return done(JSON.stringify({ ...value, Config: { ...value.Config, Labels: {} } }));
          return done(JSON.stringify(value));
        }
        if (command === "create") {
          const option = (name: string) => args[args.indexOf(name) + 1]!;
          const name = option("--name"); const manager = name.includes("-manager-"); const id = String(++created).repeat(64); const nonce = name.replace(/^fleur-desktop-(worker|manager)-/, "");
          const environment = args.flatMap((value, index) => value === "--env" ? [args[index + 1]!] : []);
          const program = args.slice(args.lastIndexOf(image) + 1);
          if (manager) managerPrograms.push(program.at(-1)!);
          const memory = manager ? 268435456 : 536870912;
          const value: FixtureContainer = { Id: id, Name: `/${name}`, Image: image, Mounts: [], State: { Running: false, Pid: 0 }, Config: { User: manager ? "0:0" : "65534:65534", Entrypoint: ["/usr/local/bin/bun"], Cmd: program, Env: ["PATH=/usr/bin:/bin", ...environment], Volumes: null, Labels: { "dev.fleur.desktop-control-owner": nonce, "dev.fleur.desktop-control-role": manager ? "manager" : "worker" } }, HostConfig: { Privileged: false, Binds: null, NetworkMode: "none", ReadonlyRootfs: true, PidMode: manager ? "host" : "", CgroupnsMode: manager ? "host" : "private", CapDrop: ["ALL"], CapAdd: manager ? ["KILL", "SYS_PTRACE"] : null, Memory: memory, MemorySwap: memory, NanoCpus: 1000000000, PidsLimit: 64, SecurityOpt: manager ? ["no-new-privileges", "seccomp=unconfined", ...(mode === "native-manager-label" ? ["label=disable"] : [])] : ["no-new-privileges"] } };
          names.set(name, id); states.set(id, value); return done(`${id}\n`);
        }
        if (command === "start") {
          const value = states.get(args[4]!)!; value.State = { Running: true, Pid: value.Config.User === "0:0" ? 456 : 123 };
          if (value.Config.User !== "0:0" && mode === "source-race") await writeFile(join(directory, "scripts/desktop-control-probe.ts"), 'throw new Error("UNATTESTED_CHANGED_PROGRAM");\n');
          if (value.Config.User !== "0:0" && mode === "uncertain-start") return { ...done(), terminationUnconfirmed: true };
          return done();
        }
        if (command === "logs") { managerLogged = true; return done('{}\n'); }
        if (command === "rm") { const id = args.at(-1)!; removed.push(id); states.delete(id); return done(`${id}\n`); }
        throw new Error("Unexpected controlled Docker command");
      },
    };
    const report = await observeDesktopControl(host, candidate);
    return { report, managerPrograms, originalProgram, removed, remaining: [...states.keys()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Desktop root manager executes the exact attested bytes despite later source replacement", async () => {
  const result = await scenario("source-race");
  expect(result.managerPrograms).toEqual([result.originalProgram]);
  expect(result.report.ok).toBe(false); // Controlled manager returns no capability proof.
  expect(result.report.originalPreserved).toBe(true);
  expect(result.remaining).toEqual([]);
});

test("uncertain worker start cannot launch a root manager or become passing capability evidence", async () => {
  const result = await scenario("uncertain-start");
  expect(result.report.ok).toBe(false);
  expect(result.report.transportUncertain).toBe(true);
  expect(result.managerPrograms).toEqual([]);
  expect(result.removed).toEqual(["1".repeat(64)]);
  expect(result.remaining).toEqual([]);
  expect(result.report.originalPreserved).toBe(true);
});

test("Desktop cleanup preserves a container whose ownership evidence changed", async () => {
  const result = await scenario("ownership-drift");
  expect(result.report.ok).toBe(false);
  expect(result.removed).toEqual(["2".repeat(64)]);
  expect(result.remaining).toEqual(["1".repeat(64)]);
  expect(result.report.originalPreserved).toBe(false);
  expect(result.report.cleanup).toContainEqual({ kind: "worker", absent: false, error: "OWNED_CLEANUP_UNCONFIRMED" });
});


test("actual Desktop lowercase absence protocol permits fresh creation and confirms owned cleanup", async () => {
  const result = await scenario("native-absence");
  expect(result.managerPrograms).toEqual([result.originalProgram]);
  expect(result.report.error).toBe("CONTROL_CAPABILITY_UNPROVEN");
  expect(result.report.ok).toBe(false); // Absence is not capability proof.
  expect(result.removed).toEqual(["1".repeat(64), "2".repeat(64)]);
  expect(result.remaining).toEqual([]);
  expect(result.report.originalPreserved).toBe(true);
  expect(result.report.transportUncertain).toBe(false);
  expect(result.report.cleanup).toEqual([{ kind: "worker", absent: true }, { kind: "manager", absent: true }]);
});


test("actual host-PID manager label normalization preserves controller ownership and cleanup gates", async () => {
  const result = await scenario("native-manager-label");
  expect(result.report.error).toBe("CONTROL_CAPABILITY_UNPROVEN");
  expect(result.report.ok).toBe(false); // The profile alone never proves control capability.
  expect(result.managerPrograms).toEqual([result.originalProgram]);
  expect(result.removed).toEqual(["1".repeat(64), "2".repeat(64)]);
  expect(result.remaining).toEqual([]);
  expect(result.report.originalPreserved).toBe(true);
  expect(result.report.cleanup).toEqual([{ kind: "worker", absent: true }, { kind: "manager", absent: true }]);
});


test("selected Desktop 4.97 candidate reaches the original proof without runtime admission", async () => {
  const { report, managerPrograms } = await scenario("native-absence", "desktop-4.97.0-244584", "Docker Desktop 4.97.0 (244584)");
  expect(report.error).toBe("CONTROL_CAPABILITY_UNPROVEN");
  expect(report.candidate).toBe("desktop-4.97.0-244584");
  expect(managerPrograms).toHaveLength(1);
  expect(report.runtimeAdmission).toBe(false);
  expect(report.originalPreserved).toBe(true);
});

test("candidate selection refuses unknown tuples, mismatched Desktop builds and Compose before creation", async () => {
  for (const [candidate, platform, compose] of [
    ["unknown", "Docker Desktop 4.97.0 (244584)", "5.6.1"],
    ["desktop-4.97.0-244584", "Docker Desktop 4.96.1 (244132)", "5.6.1"],
    ["desktop-4.96.1-244132", "Docker Desktop 4.97.0 (244584)", "5.6.1"],
    ["desktop-4.97.0-244584", "Docker Desktop 4.97.0 (244585)", "5.6.1"],
    ["desktop-4.97.0-244584", "Docker Desktop 4.97.0 (244584)", "5.6.0"],
  ]) {
    const { report, managerPrograms, removed } = await scenario("native-absence", candidate, platform, compose);
    expect(report.ok).toBe(false);
    expect(report.runtimeAdmission).toBe(false);
    expect(report.error).toBe("EXACT_DESKTOP_TUPLE_REQUIRED");
    expect(managerPrograms).toEqual([]);
    expect(removed).toEqual([]);
  }
});


test("Desktop 4.97 candidate refuses changed OS, CLI, components and rootful cgroup security tuple", async () => {
  for (const tuple of [
    { release: "15.7.8" },
    { cli: { Version: "29.9.2", GitCommit: "other", Os: "darwin", Arch: "amd64" } },
    { components: [] },
    { components: [{ Name: "containerd", Version: "v2.4.3", Details: { GitCommit: "other" } }] },
    { security: '"cgroupfs"|"2"|["name=rootless","name=seccomp,profile=builtin","name=cgroupns"]\n' },
  ]) {
    const { report, managerPrograms, removed } = await scenario("native-absence", "desktop-4.97.0-244584", "Docker Desktop 4.97.0 (244584)", "5.6.1", tuple);
    expect(report.error).toBe("EXACT_DESKTOP_TUPLE_REQUIRED");
    expect(report.runtimeAdmission).toBe(false);
    expect(managerPrograms).toEqual([]);
    expect(removed).toEqual([]);
  }
});
