// Run only by run-sweep.test.ts, which expects this file to fail and leak.
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sweepDevelopmentRootAfterRun, sweepLabelAfterRun } from "../run-sweep";
import { ownedPostgres } from "../owned-postgres";
import { prepareNativeImages } from "../../../src/runtime/native/build";
import { startWorker } from "../../../src/runtime/native/host";
import { NativeExecution } from "../../../src/runtime/native/execution";
import { RetainedLease, executionLabel } from "../../../src/runtime/native/retained-lease";

const root = process.env.FLEUR_RUN_SWEEP_ROOT!, report = process.env.FLEUR_RUN_SWEEP_REPORT!, label = process.env.FLEUR_RUN_SWEEP_LABEL!;
const nativeReport = process.env.FLEUR_RUN_SWEEP_NATIVE_REPORT!;
const binding = "ab".repeat(32), image = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
const docker = (...args: string[]) => { const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" }); if (!result.success) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };

test("a failed assertion abandons native execution containers", async () => {
  const images = await prepareNativeImages("module.exports.run = async () => ({kind:'complete',value:'abandoned'});");
  // Report the images first: the sweep leaves them, and the outer test removes them once their containers are gone.
  await writeFile(nativeReport, JSON.stringify({ images: [images.worker, images.controller], endpoint: images.endpoint, labels: [], containers: [], released: null }));
  const worker = await startWorker(images);
  const execution = await NativeExecution.open(images, { capacity: 1 });
  const result = await execution.execute({}, () => null);
  expect(result.value).toEqual({ kind: "complete", value: "abandoned" });
  const lease = JSON.parse(await Bun.file(join(worker.recoveryDirectory, "lease.json")).text()) as { owner: string };
  const owned = (label: string) => docker("--host", images.endpoint, "ps", "--all", "--quiet", "--filter", `label=${label}`).split("\n").filter(Boolean);
  const labels = [`dev.fleur.read-controller-owner=${lease.owner}`, `fleur.compatibility.runtime-owner=fleur-read-${lease.owner}`, `${executionLabel}=${result.operation!.slot}`];
  // A lease retired by its owner, here through its recovered journal, is no longer the sweep's: a resource carrying its label survives.
  const retired = await RetainedLease.recover((await RetainedLease.create(crypto.randomUUID(), images)).recoveryDirectory);
  await retired.abandon();
  const released = docker("--host", images.endpoint, "volume", "create", "--label", `${executionLabel}=${retired.owner}`);
  await writeFile(nativeReport, JSON.stringify({ images: [images.worker, images.controller], endpoint: images.endpoint, labels, containers: labels.map(owned), released }));
  expect("native cleanup skipped").toBe("native cleanup reached");
  await Promise.all([worker.close(), execution.close()]);
  await images.dispose();
}, 300_000);
test("a test timeout abandons its cleanup", async () => {
  await Bun.sleep(5_000);
}, 50);
// Last, because Bun itself kills processes left behind by a timed-out test; only the sweep can kill this one.
test("a failed assertion skips its cleanup", async () => {
  sweepDevelopmentRootAfterRun(root);
  await mkdir(join(root, ".local/state/fleur/development", binding), { recursive: true });
  const supervisor = Bun.spawn([process.execPath, "-e", "await Bun.sleep(300000)", join(root, "app")], { stdio: ["ignore", "ignore", "ignore"], detached: true });
  supervisor.unref();
  const database = await ownedPostgres();
  const development = docker("create", "--label", `dev.fleur.development-binding=${binding}`, "--label", label, image);
  const volume = docker("volume", "create", "--label", `dev.fleur.development-binding=${binding}`, "--label", label);
  const labelled = docker("volume", "create", "--label", `${label}-direct`);
  sweepLabelAfterRun(`${label}-direct`);
  const released = docker("volume", "create", "--label", `${label}-released`);
  sweepLabelAfterRun(`${label}-released`)();
  const container = new URL(database.url).username.replaceAll("_", "-");
  await writeFile(report, JSON.stringify({ pid: supervisor.pid, container, development, volume, labelled, released }));
  expect("cleanup skipped").toBe("cleanup reached");
  await database.cleanup();
}, 120_000);
