import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startIdentity } from "../../src/runtime/development/state";
import { databaseLabel } from "../../src/runtime/development/postgres";
import { developmentBindingLabel, sweepDevelopmentRootAfterRun } from "./run-sweep";

const docker = (...args: string[]) => {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
  return { ok: result.success, output: result.stdout.toString().trim() };
};

test("the sweep removes the label development PostgreSQL actually carries", () => {
  expect(developmentBindingLabel).toBe(databaseLabel);
});

test("the sweep refuses a root outside the temporary directory", () => {
  expect(() => sweepDevelopmentRootAfterRun(resolve(import.meta.dir, "../.."))).toThrow("only temporary roots");
});

test("resources abandoned by failed and timed-out tests are released when the test process exits", async () => {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "fleur-run-sweep-")), root = join(scratch, "project-root"), report = join(scratch, "report.json"), nativeReport = join(scratch, "native.json");
  const label = `fleur.run-sweep.fixture=${crypto.randomUUID()}`;
  let native: { images: string[]; endpoint: string; labels: string[]; containers: string[][]; released: string | null } | undefined;
  let leaked: { pid: number; container: string; development: string; volume: string; labelled: string; released: string } | undefined;
  try {
    const child = Bun.spawn([process.execPath, "test", "./tests/runtime/fixtures/run-sweep.fixture.ts"], { cwd: resolve(import.meta.dir, "../.."), env: { ...process.env, FLEUR_RUN_SWEEP_ROOT: root, FLEUR_RUN_SWEEP_REPORT: report, FLEUR_RUN_SWEEP_LABEL: label, FLEUR_RUN_SWEEP_NATIVE_REPORT: nativeReport }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stdout + stderr).toBe(1);
    expect(stdout + stderr).toContain("3 fail");
    expect(stdout + stderr).not.toContain("Run sweep could not release");
    leaked = await Bun.file(report).json() as NonNullable<typeof leaked>;
    expect(await startIdentity(leaked.pid)).toBeNull();
    expect(docker("ps", "--all", "--quiet", "--filter", `name=^/${leaked.container}$`).output).toBe("");
    expect(docker("inspect", leaked.development).ok).toBe(false);
    expect(docker("volume", "inspect", leaked.volume).ok).toBe(false);
    expect(docker("volume", "inspect", leaked.labelled).ok).toBe(false);
    expect(await stat(root).then(() => true, () => false)).toBe(false);
    // A label its owner released is no longer the sweep's to remove.
    expect(docker("volume", "inspect", leaked.released).ok).toBe(true);
    // Native execution: each owner label of a read worker and a retained slot had containers, and none survived.
    native = await Bun.file(nativeReport).json() as NonNullable<typeof native>;
    expect(native.labels).toHaveLength(3);
    expect(native.containers.map(ids => ids.length >= 1)).toEqual([true, true, true]);
    for (const label of native.labels) expect(docker("--host", native.endpoint, "ps", "--all", "--quiet", "--filter", `label=${label}`).output).toBe("");
    expect(docker("--host", native.endpoint, "volume", "inspect", native.released!).ok).toBe(true);
  } finally {
    if (leaked) {
      try { process.kill(leaked.pid, "SIGKILL"); } catch { /* Already gone. */ }
      docker("rm", "--force", leaked.container, leaked.development);
      for (const volume of [leaked.volume, leaked.labelled, leaked.released]) docker("volume", "rm", volume);
    }
    native ??= await Bun.file(nativeReport).json().catch(() => undefined) as typeof native;
    if (native) {
      for (const label of native.labels) {
        const ids = docker("--host", native.endpoint, "ps", "--all", "--quiet", "--filter", `label=${label}`).output.split("\n").filter(Boolean);
        if (ids.length) docker("--host", native.endpoint, "rm", "--force", ...ids);
      }
      if (native.released) docker("--host", native.endpoint, "volume", "rm", native.released);
      for (const image of native.images) docker("--host", native.endpoint, "image", "rm", "--force", image);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}, 600_000);
