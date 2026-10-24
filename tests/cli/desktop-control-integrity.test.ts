import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SetupHost } from "../../src/setup/commands.ts";

type FixtureContainer = { Id: string; Name: string; Image: string; Mounts: unknown[]; Config: Record<string, unknown>; HostConfig: Record<string, unknown>; State: { Running: boolean; Pid: number } };
async function scenario(mode: "source-race" | "uncertain-start" | "ownership-drift") {
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
      host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.7" }),
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
        if (command === "version") return done(JSON.stringify({ Platform: { Name: "Docker Desktop 4.96.1 (244132)" }, Version: "29.9.2", GitCommit: "0367cbe", Os: "linux", Arch: "amd64", KernelVersion: "7.0.14-linuxkit" }));
        if (command === "info") return done('"fixed-daemon"|"29.9.2"|"7.0.14-linuxkit"|"x86_64"|"cgroupfs"|"2"\n');
        if (command === "ps") return done([...states.keys()].sort().join("\n"));
        if (command === "image") return args[4] === "inspect" ? done(JSON.stringify([{ Id: image, Architecture: "amd64", Os: "linux", Config: { Volumes: null } }])) : done(`${image}\n`);
        if (command === "inspect") {
          const target = args[4]!; const value = states.get(target) ?? states.get(names.get(target) ?? "");
          if (!value) return done("", 1, `Error: No such object: ${target}\n`);
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
          const value: FixtureContainer = { Id: id, Name: `/${name}`, Image: image, Mounts: [], State: { Running: false, Pid: 0 }, Config: { User: manager ? "0:0" : "65534:65534", Entrypoint: ["/usr/local/bin/bun"], Cmd: program, Env: ["PATH=/usr/bin:/bin", ...environment], Volumes: null, Labels: { "dev.fleur.desktop-control-owner": nonce, "dev.fleur.desktop-control-role": manager ? "manager" : "worker" } }, HostConfig: { Privileged: false, Binds: null, NetworkMode: "none", ReadonlyRootfs: true, PidMode: manager ? "host" : "", CgroupnsMode: manager ? "host" : "private", CapDrop: ["ALL"], CapAdd: manager ? ["KILL", "SYS_PTRACE"] : null, Memory: memory, MemorySwap: memory, NanoCpus: 1000000000, PidsLimit: 64, SecurityOpt: manager ? ["no-new-privileges", "seccomp=unconfined"] : ["no-new-privileges"] } };
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
