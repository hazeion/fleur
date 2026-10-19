import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import type { AptInstallProfile } from "../../src/setup/native.ts";

const profile: AptInstallProfile = {
  method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64",
  repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88",
  packages: { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" },
};
async function observeSetup(status: string) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-package-state-"));
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: directory, handlers: setupCommands({
      stateDirectory: join(directory, "state"),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "24.04", distribution: "ubuntu", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] !== "dpkg-query") throw new Error("Existing package state cannot authorize machine changes");
        const includesStatus = args.some((arg) => arg.includes("${db:Status-Status}"));
        const stdout = includesStatus
          ? `docker-ce\t1\t${status}\ndocker-ce-cli\t1\tinstalled\ncontainerd.io\t2\tinstalled\ndocker-buildx-plugin\t1\tinstalled\ndocker-compose-plugin\t1\tinstalled\n`
          : "docker-ce=1\ndocker-ce-cli=1\ncontainerd.io=2\ndocker-buildx-plugin=1\ndocker-compose-plugin=1\n";
        return { status: "completed", exitCode: 0, stdout, stderr: "" };
      },
    }, [profile]) });
    return { outcome, calls };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("setup observes dpkg configuration status and refuses an exact-version half-configured package", async () => {
  const result = await observeSetup("half-configured");
  expect(result.calls.find((args) => args[0] === "dpkg-query")?.some((arg) => arg.includes("${db:Status-Status}"))).toBe(true);
  expect(result.outcome.exitCode).toBe(4);
  expect(result.outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
  expect(result.calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
});
