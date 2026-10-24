import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArchPackageState } from "../../src/setup/arch-package-state.ts";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import type { ArchInstallProfile } from "../../src/setup/native-arch.ts";

const names = ["containerd", "docker", "docker-compose", "runc"] as const;
const versions = { containerd: "1.0-1", docker: "1.0-1", "docker-compose": "1.0-1", runc: "1.0-1" };
const absent = (missing: readonly string[]) => missing.map((name) => `error: package '${name}' was not found\n`).join("");

test("Arch package parser rejects truncated, foreign, conflicting and oversized evidence", () => {
  const missingDocker = names.filter((name) => name !== "docker");
  for (const [code, out, error] of [
    [1, "docker 1.0-1", absent(missingDocker)], [1, "docker 1.0-1\r\n", absent(missingDocker)],
    [1, "docker 1.0-1\ndocker 1.0-1\n", absent(missingDocker)], [1, "docker 2.0-1\n", absent(missingDocker)],
    [1, "docker:amd64 1.0-1\n", absent(missingDocker)], [1, "nftables 1.0-1\n", absent(names)],
    [1, "", absent([...names].reverse())], [1, "", absent(names).replaceAll("\n", "\r\n")],
    [1, "", absent(names).slice(0, -1)], [1, "", absent(names) + "database read failure\n"],
    [1, "x".repeat(4097), absent(names)], [1, "", "x".repeat(4097)],
  ] as const) expect(parseArchPackageState(code, out, error, versions)).toBeNull();
  expect(parseArchPackageState(0, [...names].reverse().map((name) => `${name} 1.0-1\n`).join(""), "", versions)).toEqual({ present: [...names], missing: [] });
});

test("indeterminate Arch state preserves preexisting grants and other private evidence byte-for-byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-arch-preserve-"));
  try {
    const state = join(root, "state"); await mkdir(state, { mode: 0o700 });
    const machine = "b".repeat(64); const grants = JSON.stringify({ formatVersion: 1, grants: [{ id: crypto.randomUUID(), action: "install", method: "arch-official-pacman", target: "original retained target", planChecksum: "c".repeat(64), machine, user: process.getuid!(), mode: "once", revoked: false }] });
    const pending = '{"original":"unresolved transaction evidence"}\n';
    await writeFile(join(state, "grants.json"), grants, { mode: 0o600 });
    await writeFile(join(state, "retained-private-evidence.json"), pending, { mode: 0o600 });
    const before = await lstat(join(state, "grants.json"));
    const packages = Object.fromEntries(names.map((name) => [name, { version: versions[name], url: `https://archive.archlinux.org/packages/${name[0]}/${name}/${name}-1.0-1-x86_64.pkg.tar.zst`, sha256: "a".repeat(64), size: 1, signature: "c2ln", signer: "A".repeat(40) }])) as ArchInstallProfile["packages"];
    const profile: ArchInstallProfile = { method: "arch-official-pacman", verified: true, distribution: "arch", release: "rolling", architecture: "x64", snapshot: "2026-10-12", packages };
    const mutations: string[][] = [];
    const outcome = await runCli(["setup", "--json"], { cwd: root, handlers: setupCommands({ stateDirectory: state,
      host: async () => ({ system: "linux", architecture: "x64", translated: false, distribution: "arch", release: "rolling", machineId: machine }),
      run: async (args) => {
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "pacman" && args.includes("--query")) return { status: "completed", exitCode: 1, stdout: "", stderr: "" };
        mutations.push([...args]); return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
      },
    }, [profile]) });
    expect(outcome.exitCode).toBe(4); expect(outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(mutations).toEqual([]);
    expect(await readFile(join(state, "grants.json"), "utf8")).toBe(grants);
    expect(await readFile(join(state, "retained-private-evidence.json"), "utf8")).toBe(pending);
    const after = await lstat(join(state, "grants.json")); expect(after.ino).toBe(before.ino); expect(after.mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mismatch of ["newly-missing", "newly-present", "matching-control"] as const) {
  test(`actual Arch guard binds complete query state to the original missing plan: ${mismatch}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-arch-guard-integrity-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const planned = mismatch === "newly-present" ? [...names] : ["docker"];
      const present = mismatch === "newly-missing" ? [] : names.filter((name) => name !== "docker");
      const missing = names.filter((name) => !(present as readonly string[]).includes(name));
      await writeFile(join(tools, "pacman"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(present.map((name) => `${name} 1.0-1\n`).join(""))});process.stderr.write(${JSON.stringify(absent(missing))});process.exit(1);\n`, { mode: 0o700 });
      const raw = JSON.stringify({ formatVersion: 1, user: process.getuid!(), packages: versions, missing: planned });
      const plan = join(root, "plan.json"); await writeFile(plan, raw, { mode: 0o600 });
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/setup/arch-pre-transaction.ts"), plan, Bun.CryptoHasher.hash("sha256", raw, "hex")], { env: { PATH: tools }, stdin: Buffer.from(planned.join("\n") + "\n"), stdout: "pipe", stderr: "pipe", timeout: 5000 });
      const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ out, error, code }).toEqual({ out: "", error: "", code: mismatch === "matching-control" ? 0 : 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
