import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startIdentity } from "../../src/runtime/development/state";
import { sweepDevelopmentRootAtExit } from "./exit-sweep";

const docker = (...args: string[]) => {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: result.success, output: result.stdout.toString().trim() };
};

test("the sweep refuses a root outside the temporary directory", () => {
  expect(() => sweepDevelopmentRootAtExit(resolve(import.meta.dir, "../.."))).toThrow("only temporary roots");
});

test("resources abandoned by failed and timed-out tests are released when the test process exits", async () => {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "fleur-exit-sweep-")), root = join(scratch, "project-root"), report = join(scratch, "report.json");
  const label = `fleur.exit-sweep.fixture=${crypto.randomUUID()}`;
  let leaked: { pid: number; container: string; development: string; volume: string; labelled: string; released: string } | undefined;
  try {
    const child = Bun.spawn([process.execPath, "test", "./tests/runtime/fixtures/exit-sweep.fixture.ts"], { cwd: resolve(import.meta.dir, "../.."), env: { ...process.env, FLEUR_EXIT_SWEEP_ROOT: root, FLEUR_EXIT_SWEEP_REPORT: report, FLEUR_EXIT_SWEEP_LABEL: label }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stdout + stderr).toBe(1);
    expect(stdout + stderr).toContain("2 fail");
    expect(stdout + stderr).not.toContain("Exit sweep could not release");
    leaked = await Bun.file(report).json() as NonNullable<typeof leaked>;
    expect(await startIdentity(leaked.pid)).toBeNull();
    expect(docker("ps", "--all", "--quiet", "--filter", `name=^/${leaked.container}$`).output).toBe("");
    expect(docker("inspect", leaked.development).ok).toBe(false);
    expect(docker("volume", "inspect", leaked.volume).ok).toBe(false);
    expect(docker("volume", "inspect", leaked.labelled).ok).toBe(false);
    expect(await stat(root).then(() => true, () => false)).toBe(false);
    // A label its owner released is no longer the sweep's to remove.
    expect(docker("volume", "inspect", leaked.released).ok).toBe(true);
  } finally {
    if (leaked) {
      try { process.kill(leaked.pid, "SIGKILL"); } catch { /* Already gone. */ }
      docker("rm", "--force", leaked.container, leaked.development);
      for (const volume of [leaked.volume, leaked.labelled, leaked.released]) docker("volume", "rm", volume);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}, 180_000);
