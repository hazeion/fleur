import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import type { ArchInstallProfile } from "../../src/setup/native-arch.ts";

const names = ["containerd", "docker", "docker-compose", "runc"] as const;
const packages = Object.fromEntries(names.map((name) => [name, { version: "1.0-1", url: `https://archive.archlinux.org/packages/${name[0]}/${name}/${name}-1.0-1-x86_64.pkg.tar.zst`, sha256: "a".repeat(64), size: 1, signature: "c2ln", signer: "A".repeat(40) }])) as ArchInstallProfile["packages"];
const profile: ArchInstallProfile = { method: "arch-official-pacman", verified: true, distribution: "arch", release: "rolling", architecture: "x64", snapshot: "2026-10-12", packages };
const absent = (list: readonly string[]) => list.map((name) => `error: package '${name}' was not found\n`).join("");
const bad = [
  { label: "empty failure", code: 1, out: "", error: "" },
  { label: "incomplete missing rows", code: 1, out: "", error: absent([names[0]]) },
  { label: "unknown package", code: 1, out: "", error: absent(["unrelated-package"]) },
  { label: "duplicate missing rows", code: 1, out: "", error: absent([...names, names[0]]) },
  { label: "reported missing present package", code: 1, out: "containerd 1.0-1\n", error: absent(names) },
  { label: "successful incomplete query", code: 0, out: "", error: "" },
  { label: "failed complete inventory", code: 1, out: names.map((name) => `${name} 1.0-1\n`).join(""), error: "" },
] as const;

for (const evidence of bad) {
  test(`Arch setup preserves indeterminate package state before authority: ${evidence.label}`, async () => {
    const root = await mkdtemp("/tmp/fleur-arch-state-"); const calls: string[][] = [];
    try {
      const outcome = await runCli(["setup", "--json"], { cwd: root, handlers: setupCommands({ stateDirectory: join(root, "state"),
        host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "rolling", distribution: "arch", machineId: "b".repeat(64) }),
        run: async (args) => {
          calls.push([...args]);
          if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
          if (args[0] === "pacman" && args.includes("--query")) return { status: "completed", exitCode: evidence.code, stdout: evidence.out, stderr: evidence.error };
          if (args[0] === "stat") return { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
          return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
        },
      }, [profile]) });
      expect(outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
      expect(outcome.exitCode).toBe(4);
      expect(calls.some((args) => args[0] === "sudo" || args[0] === "curl" || (args[0] === "pacman" && (args.includes("--version") || args.includes("--database"))))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const evidence of bad) {
  test(`Arch held-lock guard refuses ambiguous package evidence: ${evidence.label}`, async () => {
    const root = await mkdtemp("/tmp/fleur-arch-guard-state-");
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      await writeFile(join(tools, "pacman"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(evidence.out)});process.stderr.write(${JSON.stringify(evidence.error)});process.exit(${evidence.code});\n`, { mode: 0o700 });
      const raw = JSON.stringify({ formatVersion: 1, user: process.getuid!(), packages: Object.fromEntries(names.map((name) => [name, "1.0-1"])), missing: [...names] });
      const plan = join(root, "plan.json"); await writeFile(plan, raw, { mode: 0o600 });
      const child = Bun.spawn([process.execPath, new URL("../../src/setup/arch-pre-transaction.ts", import.meta.url).pathname, plan, Bun.CryptoHasher.hash("sha256", raw, "hex")], { env: { PATH: tools }, stdin: Buffer.from(names.join("\n") + "\n"), stdout: "pipe", stderr: "pipe", timeout: 5000 });
      const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ out, error }).toEqual({ out: "", error: "" }); expect(code).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const present of [[], ["containerd", "runc"]] as const) {
  test(`Arch held-lock guard accepts complete exact native query evidence with ${present.length} compatible packages`, async () => {
    const root = await mkdtemp("/tmp/fleur-arch-guard-known-");
    try {
      const missing = names.filter((name) => !(present as readonly string[]).includes(name));
      const stdout = present.map((name) => `${name} 1.0-1\n`).join(""); const stderr = absent(missing);
      const tools = join(root, "tools"); await mkdir(tools);
      await writeFile(join(tools, "pacman"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exit(1);\n`, { mode: 0o700 });
      const raw = JSON.stringify({ formatVersion: 1, user: process.getuid!(), packages: Object.fromEntries(names.map((name) => [name, "1.0-1"])), missing });
      const plan = join(root, "plan.json"); await writeFile(plan, raw, { mode: 0o600 });
      const child = Bun.spawn([process.execPath, new URL("../../src/setup/arch-pre-transaction.ts", import.meta.url).pathname, plan, Bun.CryptoHasher.hash("sha256", raw, "hex")], { env: { PATH: tools }, stdin: Buffer.from(missing.join("\n") + "\n"), stdout: "pipe", stderr: "pipe", timeout: 5000 });
      const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ out, error, code }).toEqual({ out: "", error: "", code: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const uncertain of [false, true]) {
  test(`Arch planner requires canonical missing rows from a clean completed query, termination uncertainty=${uncertain}`, async () => {
    const root = await mkdtemp("/tmp/fleur-arch-known-state-");
    const queryContexts: unknown[] = []; const mutations: string[][] = [];
    try {
      const outcome = await runCli(["setup", "--json"], { cwd: root, handlers: setupCommands({ stateDirectory: join(root, "state"),
        host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "rolling", distribution: "arch", machineId: "b".repeat(64) }),
        run: async (args, _timeout, context) => {
          if (args[0] === "sudo" || args[0] === "curl") mutations.push([...args]);
          if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
          if (args[0] === "pacman" && args.includes("--query")) { queryContexts.push(context); return { status: "completed", exitCode: 1, stdout: "", stderr: absent(names), ...(uncertain ? { terminationUnconfirmed: true } : {}) }; }
          if (args[0] === "stat") return { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
          return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
        },
      }, [profile]) });
      expect(outcome.result.error?.code).toBe(uncertain ? "PREREQUISITE_UNAVAILABLE" : "AUTHORITY_REQUIRED");
      expect(queryContexts.at(-1)).toEqual({ cleanEnvironment: true });
      expect(mutations).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
