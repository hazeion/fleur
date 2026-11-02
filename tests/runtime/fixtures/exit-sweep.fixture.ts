// Run only by exit-sweep.test.ts, which expects this file to fail and leak.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sweepDevelopmentRootAtExit, sweepLabelAtExit } from "../exit-sweep";
import { ownedPostgres } from "../owned-postgres";

const root = process.env.FLEUR_EXIT_SWEEP_ROOT!, report = process.env.FLEUR_EXIT_SWEEP_REPORT!, label = process.env.FLEUR_EXIT_SWEEP_LABEL!;
const binding = "ab".repeat(32), image = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
const docker = (...args: string[]) => { const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" }); if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };

test("a test timeout abandons its cleanup", async () => {
  await Bun.sleep(5_000);
}, 50);
// Last, because Bun itself kills processes left behind by a timed-out test; only the sweep can kill this one.
test("a failed assertion skips its cleanup", async () => {
  sweepDevelopmentRootAtExit(root);
  await mkdir(join(root, ".local/state/fleur/development", binding), { recursive: true });
  const supervisor = Bun.spawn([process.execPath, "-e", "await Bun.sleep(300000)", join(root, "app")], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  supervisor.unref();
  const database = await ownedPostgres();
  const development = docker("create", "--label", `dev.fleur.development-binding=${binding}`, "--label", label, image);
  const volume = docker("volume", "create", "--label", `dev.fleur.development-binding=${binding}`, "--label", label);
  const labelled = docker("volume", "create", "--label", `${label}-direct`);
  sweepLabelAtExit(`${label}-direct`);
  const released = docker("volume", "create", "--label", `${label}-released`);
  sweepLabelAtExit(`${label}-released`)();
  const container = new URL(database.url).username.replaceAll("_", "-");
  await writeFile(report, JSON.stringify({ pid: supervisor.pid, container, development, volume, labelled, released }));
  expect("cleanup skipped").toBe("cleanup reached");
  await database.cleanup();
}, 120_000);
