import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SetupHost } from "../../src/setup/commands.ts";

type FixtureContainer = { Id: string; Name: string; Image: string; Mounts: unknown[]; Config: Record<string, unknown>; HostConfig: Record<string, unknown>; State: { Running: boolean; Pid: number } };
type Architecture = "arm64" | "x64";
const desktops = {
  arm64: { machine: "aarch64", docker: "arm64", image: "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023", server: { Platform: { Name: "Docker Desktop 4.99.0 (245822)" }, Version: "29.9.3", GitCommit: "70efc0e", Os: "linux", Arch: "arm64", KernelVersion: "7.0.14-linuxkit" } },
  x64: { machine: "x86_64", docker: "amd64", image: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e", server: { Platform: { Name: "Docker Desktop 4.96.1 (244132)" }, Version: "29.9.2", GitCommit: "0367cbe", Os: "linux", Arch: "amd64", KernelVersion: "7.0.14-linuxkit" } },
} as const;
type Scenario = "source-race" | "uncertain-start" | "ownership-drift" | "native-absence" | "native-manager-label" | "foreign-tuple";
async function scenario(mode: Scenario, architecture: Architecture = "arm64", identity?: { system: string; architecture: string; translated: boolean | null }) {
  const desktop = desktops[architecture]; const other = desktops[architecture === "arm64" ? "x64" : "arm64"];
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
    const states = new Map<string, FixtureContainer>(); const names = new Map<string, string>(); const removed: string[] = []; const managerPrograms: string[] = []; const commands: string[][] = []; const platforms: string[] = []; const inspectedImages: string[] = [];
    let created = 0; let managerLogged = false;
    const done = (stdout = "", exitCode = 0, stderr = "") => ({ status: "completed" as const, stdout, stderr, exitCode });
    const host: SetupHost = {
      environment: { DOCKER_HOST: "unix:///private/controlled-desktop.sock" },
      host: async () => ({ system: "darwin", architecture, translated: false, release: "15.7.7", ...identity }) as never,
      run: async (input) => {
        const args = [...input]; commands.push(args);
        if (args[0] === "git") {
          if (args[1] === "rev-parse") return done(`${"a".repeat(40)}\n`);
          if (args[1] === "diff") return done();
          if (args[1] === "show") return done(await readFile(join(directory, args[2]!.split(":").slice(1).join(":")), "utf8"));
        }
        if (args[0] !== "docker") throw new Error("Unexpected controlled command");
        if (args[1] === "context") return done("desktop-linux\n");
        const command = args[3];
        if (command === "version") return done(JSON.stringify(mode === "foreign-tuple" ? other.server : desktop.server));
        if (command === "info") return done(`"fixed-daemon"|"${desktop.server.Version}"|"7.0.14-linuxkit"|"${desktop.machine}"|"cgroupfs"|"2"\n`);
        if (command === "ps") return done([...states.keys()].sort().join("\n"));
        if (command === "image") { if (args[4] === "inspect") inspectedImages.push(args[5]!); return args[4] === "inspect" ? done(JSON.stringify([{ Id: image, Architecture: desktop.docker, Os: "linux", Config: { Volumes: null } }])) : done(`${image}\n`); }
        if (command === "inspect") {
          const target = args[4]!; const value = states.get(target) ?? states.get(names.get(target) ?? "");
          if (!value) return mode === "native-absence" ? done("\n", 1, `error: no such object: ${target}\n`) : done("", 1, `Error: No such object: ${target}\n`);
          if (mode === "ownership-drift" && managerLogged && value.Config.User === "65534:65534") return done(JSON.stringify({ ...value, Config: { ...value.Config, Labels: {} } }));
          return done(JSON.stringify(value));
        }
        if (command === "create") {
          const option = (name: string) => args[args.indexOf(name) + 1]!;
          platforms.push(option("--platform"));
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
    const report = await observeDesktopControl(host);
    return { report, managerPrograms, originalProgram, removed, remaining: [...states.keys()], commands, platforms, inspectedImages, desktop };
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


for (const architecture of ["arm64", "x64"] as const) {
  test(`actual Desktop lowercase absence protocol permits fresh creation and confirms owned cleanup on ${architecture}`, async () => {
    const result = await scenario("native-absence", architecture);
    expect(result.managerPrograms).toEqual([result.originalProgram]);
    expect(result.report.error).toBe("CONTROL_CAPABILITY_UNPROVEN");
    expect(result.report.ok).toBe(false); // Absence is not capability proof.
    expect(result.removed).toEqual(["1".repeat(64), "2".repeat(64)]);
    expect(result.remaining).toEqual([]);
    expect(result.report.originalPreserved).toBe(true);
    expect(result.report.transportUncertain).toBe(false);
    expect(result.report.cleanup).toEqual([{ kind: "worker", absent: true }, { kind: "manager", absent: true }]);
    expect(result.report.scope).toBe("native-desktop-control-preflight");
    expect(result.report.architecture).toBe(architecture);
    expect(result.report.nativeHost).toMatchObject({ system: "darwin", architecture, translated: false });
    expect(result.platforms).toEqual([`linux/${result.desktop.docker}`, `linux/${result.desktop.docker}`]);
    expect(result.inspectedImages).toEqual([result.desktop.image]);
    expect(result.report.image).toEqual({ digest: result.desktop.image, id: `sha256:${"c".repeat(64)}` });
    expect(result.report.server).toEqual(result.desktop.server);
  });

  test(`the other architecture's Desktop tuple refuses on ${architecture} before any container exists`, async () => {
    const result = await scenario("foreign-tuple", architecture);
    expect(result.report.error).toBe("EXACT_DESKTOP_TUPLE_REQUIRED");
    expect(result.report.architecture).toBe(architecture);
    expect(result.platforms).toEqual([]);
    expect(result.commands.some((args) => args[3] === "create")).toBe(false);
    expect(result.report.cleanup).toEqual([]);
  });
}

test("translated execution, Linux and unknown architectures refuse before any command runs", async () => {
  for (const identity of [
    { system: "darwin", architecture: "arm64", translated: true },
    { system: "darwin", architecture: "x64", translated: true },
    { system: "darwin", architecture: "arm64", translated: null },
    { system: "darwin", architecture: "x64", translated: null },
    { system: "linux", architecture: "arm64", translated: false },
    { system: "linux", architecture: "x64", translated: false },
    { system: "darwin", architecture: "ia32", translated: false },
  ]) {
    const result = await scenario("native-absence", "arm64", identity);
    expect(result.report.error, JSON.stringify(identity)).toBe("NATIVE_MAC_REQUIRED");
    expect(result.commands).toEqual([]);
    expect(result.report.architecture).toBeNull();
    expect(result.report.scope).toBe("native-desktop-control-preflight");
    expect(result.report.nativeHost).toBeUndefined();
  }
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
