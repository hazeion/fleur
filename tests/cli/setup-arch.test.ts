import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";

const packages = {
  docker: { version: "1:29.9.0-1", url: "https://archive.archlinux.org/packages/d/docker/docker-1:29.9.0-1-x86_64.pkg.tar.zst", sha256: "3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54", size: 50000000, signature: "c2lnbmF0dXJl", signer: "2E36D8620221482FC45CB7F2A91764759326B440" },
  "docker-compose": { version: "5.6.0-1", url: "https://archive.archlinux.org/packages/d/docker-compose/docker-compose-5.6.0-1-x86_64.pkg.tar.zst", sha256: "152ccc5e901b5a9ea2d53e29b8ad7b8ec736c9da75bbd224dc472a407578690d", size: 50000000, signature: "c2lnbmF0dXJl", signer: "601F20F1D1BBBF4A78CF5B6DF6B1610B3ECDBC9F" },
  containerd: { version: "2.4.1-1", url: "https://archive.archlinux.org/packages/c/containerd/containerd-2.4.1-1-x86_64.pkg.tar.zst", sha256: "c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999", size: 50000000, signature: "c2lnbmF0dXJl", signer: "262A58EC6C51F7EA395B2E2DFDC3040B92ACA748" },
  runc: { version: "1.5.2-1", url: "https://archive.archlinux.org/packages/r/runc/runc-1.5.2-1-x86_64.pkg.tar.zst", sha256: "b204e74bba04c491d0bd71f8b5adefff538bbfc516d199bdb1a1513959977dd3", size: 50000000, signature: "c2lnbmF0dXJl", signer: "05C7775A9E8B977407FE08E69D4C5AA15426DA0A" },
};
const profile = { method: "arch-official-pacman" as const, verified: true as const, distribution: "arch" as const, release: "rolling" as const, architecture: "x64" as const, snapshot: "2026-10-12" as const, packages };

test("missing Arch Docker packages require installation, configuration and access-group authority without mutating the host", async () => {
  const directory = await mkdtemp("/tmp/fleur-arch-authority-");
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: "/tmp", handlers: setupCommands({
      stateDirectory: join(directory, "state"),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "rolling", distribution: "arch", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "stat") return { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
        return { status: "completed", exitCode: args.includes("--query") ? 1 : 0, stdout: "", stderr: "" };
      },
    }, [profile]) });
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ plan: { method: "arch-official-pacman", requiredAuthorities: ["install", "configuration", "docker-access"] } });
    expect(calls.some((args) => args[0] === "sudo" || args[0] === "curl")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function archScenario(mode: "valid" | "concurrent" | "bad-signature" | "untrusted" | "extra-dependency" | "partial" | "timeout" | "missing-key" | "foreign-removal" | "conflict-question" | "marker-sync-failure" | "marker-remove-sync-failure" | "unconfirmed") {
  const { writeFile, readFile, mkdir, readdir, lstat } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-arch-install-");
  const bytes = Object.fromEntries(Object.keys(packages).map((name) => [name, Buffer.from(`disposable archive ${name}\n`)]));
  const fixturePackages = Object.fromEntries(Object.entries(packages).map(([name, artifact]) => [name, { ...artifact, sha256: Bun.CryptoHasher.hash("sha256", bytes[name]!, "hex"), size: bytes[name]!.length }]));
  const fixtureProfile = { ...profile, packages: fixturePackages as typeof packages };
  const installed = new Set<string>(mode === "partial" ? ["containerd"] : []);
  const authorized: string[] = [];
  const calls: string[][] = [];
  let importedKeys = 0;
  let foreignPresent = true;
  let markerSynced = false;
  const baseline = "[options]\nRootDir = /\nDBPath = /var/lib/pacman/\nGPGDir = /etc/pacman.d/gnupg/\nHookDir = /etc/pacman.d/hooks/\nLocalFileSigLevel = Optional\n[core]\nServer = https://mirror.invalid/arch/$repo/os/$arch\n";
  const done = (stdout = "", exitCode = 0, stderr = "") => ({ status: "completed" as const, exitCode, stdout, stderr });
  try {
    const fixtureBin = join(directory, "bin");
    const fixtureInventory = join(directory, "guard-inventory.json");
    await mkdir(fixtureBin);
    await writeFile(join(fixtureBin, "pacman"), `#!${process.execPath}\nconst rows = await Bun.file(${JSON.stringify(fixtureInventory)}).json(); process.stdout.write(rows.join("\\n")); process.exit(rows.length === 4 ? 0 : 1);\n`, { mode: 0o700 });
    const handlers = setupCommands({
      stateDirectory: join(directory, "state"), interactive: true,
      syncDirectory: async (path) => {
        let markerExists = false;
        try { await lstat(join(path, "arch-transaction-pending.json")); markerExists = true; } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
        if (mode === "marker-sync-failure" && markerExists) throw Object.assign(new Error("Injected directory sync failure"), { code: "EIO" });
        if (mode === "marker-remove-sync-failure") { if (markerExists) markerSynced = true; else if (markerSynced) throw Object.assign(new Error("Injected removal directory sync failure"), { code: "EIO" }); }
      },
      confirmHuman: async ({ action }) => { authorized.push(action); return "once"; },
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "rolling", distribution: "arch", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "stat") return args.at(-1)?.endsWith("db.lck") ? done("", 1, "No such file or directory") : done("regular file|0|644|1\n");
        if (args[0] === "ls") return done();
        if (args[0] === "pacman-conf") {
          const values: Record<string, string> = { RootDir: "/\n", DBPath: "/var/lib/pacman/\n", GPGDir: "/etc/pacman.d/gnupg/\n", HookDir: "/etc/pacman.d/hooks/\n" };
          if (args.includes("LocalFileSigLevel")) {
            const contents = await readFile(args[args.indexOf("--config") + 1]!, "utf8");
            expect(contents).toContain("LocalFileSigLevel = Required TrustedOnly");
            expect(contents).not.toContain("[core]");
            return done("PackageRequired\nPackageTrustedOnly\n");
          }
          return done(values[args.at(-1)!] ?? baseline);
        }
        if (args[0] === "curl") {
          const artifact = Object.entries(fixturePackages).find(([, candidate]) => candidate.url === args.at(-1))!;
          await writeFile(args[args.indexOf("--output") + 1]!, bytes[artifact[0]]!); return done();
        }
        if (args[0] === "pacman" && args.includes("--version")) return done("Pacman v7.1.0 - libalpm v16.0.0\n");
        if (args[0] === "pacman" && args.includes("--query")) return done([...installed].sort().map((name) => `${name} ${fixturePackages[name]!.version}`).join("\n"), installed.size === 4 ? 0 : 1);
        if (args[0] === "pacman" && args.includes("--print")) return done(Object.entries(fixturePackages).filter(([name]) => !installed.has(name)).map(([name, artifact]) => `${name}\t${artifact.version}\tx86_64`).join("\n") + (mode === "extra-dependency" ? "\nunreviewed-dependency\t1\tx86_64" : ""));
        if (args[0] === "pacman") return done();
        if (args[0] === "sudo" && args[2] === "pacman-key") return done();
        if (args[0] === "sudo" && args[2] === "gpg") {
          const artifact = Object.values(fixturePackages).find((candidate) => args.at(-1)!.endsWith(new URL(candidate.url).pathname.split("/").at(-1)!))!;
          if (mode === "bad-signature") return done("[GNUPG:] BADSIG DEADBEEF invalid\n", 1);
          return done(`[GNUPG:] VALIDSIG ${artifact.signer} 2026-10-12 0 0 4 0 1 10 00 ${artifact.signer}\n[GNUPG:] ${mode === "untrusted" ? "TRUST_UNDEFINED" : "TRUST_FULLY"} 0 pgp\n`);
        }
        if (args[0] === "sudo" && args[2] === "pacman") {
          expect(authorized).toEqual(["install", "configuration", "docker-access"]);
          expect(args).toContain("--hookdir");
          expect(args).not.toContain("--nodeps");
          if (mode === "timeout") return { status: "timeout", stdout: "", stderr: "" };
          if (mode === "missing-key") { if ((Number(args[args.indexOf("--ask") + 1]) & 64) === 64) return done("", 1, "missing trusted signing key; import denied"); importedKeys++; }
          if (mode === "conflict-question") { if ((Number(args[args.indexOf("--ask") + 1]) & 4) === 0) return done("", 1, "conflict removal denied"); foreignPresent = false; }
          const hook = await readFile(join(args[args.indexOf("--hookdir") + 1]!, "00-fleur-preserve-existing.hook"), "utf8");
          expect(hook).toContain("When = PreTransaction");
          expect(hook).toContain("AbortOnFail");
          expect(hook).toContain("Operation = Remove");
          expect(hook).toContain("Target = *");
          const command = hook.split("\n").find((line) => line.startsWith("Exec = "))!;
          const executable = [...command.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => JSON.parse(`"${match[1]}"`) as string);
          await writeFile(fixtureInventory, JSON.stringify(mode === "concurrent" ? ["containerd 0.1.0"] : [...installed].map((name) => `${name} ${fixturePackages[name]!.version}`)));
          const guard = Bun.spawn(executable, { env: { PATH: fixtureBin }, stdin: Buffer.from([...Object.keys(packages).filter((name) => !installed.has(name)), ...(mode === "foreign-removal" ? ["unrelated-existing-package"] : [])].sort().join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
          await Promise.all([new Response(guard.stdout).text(), new Response(guard.stderr).text()]);
          if (await guard.exited !== 0) return done("", 1, "PreTransaction guard rejected changed package state");
          if (mode === "foreign-removal") foreignPresent = false;
          for (const name of Object.keys(packages)) installed.add(name);
          return mode === "unconfirmed" ? { ...done(), terminationUnconfirmed: true } : done();
        }
        throw new Error(`Unexpected fixture operation: ${args[0]}`);
      },
    }, [fixtureProfile]);
    const outcome = await runCli(["setup"], { cwd: "/tmp", handlers });
    const retry = mode === "timeout" || mode === "unconfirmed" ? await runCli(["setup"], { cwd: "/tmp", handlers }) : undefined;
    return { outcome, retry, installed, calls, baseline, authorized, importedKeys, foreignPresent, stateEntries: await readdir(join(directory, "state")) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("authorized Arch setup installs exact signed missing archives with a private stronger signature policy", async () => {
  const { outcome, installed, calls, baseline } = await archScenario("valid");
  expect(outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" }, resumable: true });
  expect(installed.size).toBe(4);
  expect(calls.filter((args) => args[0] === "curl")).toHaveLength(4);
  expect(calls.some((args) => args.includes("--sync") || args.includes("--refresh") || args[0] === "systemctl" || args[0] === "usermod")).toBe(false);
  expect(baseline).toContain("LocalFileSigLevel = Optional");
});

test("Arch's held-lock transaction guard aborts a concurrent conflicting installation before replacing any package", async () => {
  const { outcome, installed } = await archScenario("concurrent");
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
});

test("Arch setup refuses invalid archive signatures before package installation", async () => {
  const { outcome, installed } = await archScenario("bad-signature");
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(4);
});
test("Arch setup refuses a cryptographically valid signer not trusted by the current keyring", async () => {
  const { outcome, installed } = await archScenario("untrusted");
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(4);
});
test("Arch setup refuses an unreviewed dependency instead of silently changing the system", async () => {
  const { outcome, installed } = await archScenario("extra-dependency");
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(4);
});
test("Arch setup installs only missing compatible packages and preserves the existing pinned container runtime", async () => {
  const { outcome, installed, calls } = await archScenario("partial");
  expect(outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" } });
  expect(installed.size).toBe(4);
  expect(calls.filter((args) => args[0] === "curl")).toHaveLength(3);
  expect(calls.some((args) => args[0] === "curl" && args.at(-1) === packages.containerd.url)).toBe(false);
});

test("an indeterminate privileged Arch transaction retains its data and blocks new authority on retry", async () => {
  const { outcome, retry, installed, authorized, stateEntries } = await archScenario("timeout");
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(5);
  expect(retry?.exitCode).toBe(5);
  expect(authorized).toEqual(["install", "configuration", "docker-access"]);
  expect(stateEntries).toContain("arch-transaction-pending.json");
  expect(stateEntries.some((name) => name.startsWith("arch-") && name !== "arch-transaction-pending.json")).toBe(true);
});

test("an expected signing key disappearing before the Arch transaction is denied rather than imported automatically", async () => {
  const { outcome, installed, importedKeys } = await archScenario("missing-key");
  expect(importedKeys).toBe(0);
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(5);
});

test("Arch's all-operation guard rejects an unplanned foreign removal while retaining the unrelated package", async () => {
  const { outcome, installed, foreignPresent } = await archScenario("foreign-removal");
  expect(installed.size).toBe(0);
  expect(foreignPresent).toBe(true);
  expect(outcome.exitCode).toBe(5);
});
test("Arch's reviewed question policy denies conflict-removal questions", async () => {
  const { outcome, installed, foreignPresent } = await archScenario("conflict-question");
  expect(installed.size).toBe(0);
  expect(foreignPresent).toBe(true);
  expect(outcome.exitCode).toBe(5);
});

test("a pending-fence durability failure prevents privileged Arch installation and retains blocked state", async () => {
  const { outcome, installed, stateEntries } = await archScenario("marker-sync-failure");
  expect(installed.size).toBe(0);
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(stateEntries).toContain("arch-transaction-pending.json");
});
test("failure to durably remove a completed Arch transaction fence cannot report completed setup", async () => {
  const { outcome, installed, stateEntries } = await archScenario("marker-remove-sync-failure");
  expect(installed.size).toBe(4);
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(stateEntries.some((name) => name.startsWith("arch-") && name !== "arch-transaction-pending.json")).toBe(true);
});

test("unconfirmed Arch installer termination retains its pending fence even with a successful-looking exit", async () => {
  const { outcome, retry, installed, stateEntries } = await archScenario("unconfirmed");
  expect(installed.size).toBe(4);
  expect(outcome.exitCode).toBe(5);
  expect(retry?.exitCode).toBe(5);
  expect(stateEntries).toContain("arch-transaction-pending.json");
  expect(stateEntries.some((name) => name.startsWith("arch-") && name !== "arch-transaction-pending.json")).toBe(true);
});
