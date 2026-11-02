import assert from "node:assert/strict";
import { proofSource } from "./proof-source";
import { proofBrowser, closeProofContext } from "./proof-browser";
import { workoutLimits } from "./workout-limits";
import { referenceMachine } from "./reference-machine";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, release, platform, loadavg } from "node:os";
import { dirname, join } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { ownedPostgres } from "../tests/runtime/owned-postgres";
import { referenceScenario, type ReferenceSample } from "./reference-results";

interface Options {
  url: string;
  source: string;
  artifact: string;
  database: Awaited<ReturnType<typeof ownedPostgres>>;
  report: string;
  signal: AbortSignal;
  archiveSha256: string;
  releaseSource: Awaited<ReturnType<typeof proofSource>>;
}
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
/** A separate controlled reference run, never substituted for functional acceptance. */
export async function workoutReference({ url, source, artifact, database, report, signal, archiveSha256, releaseSource: packedSource }: Options) {
  await mkdir(dirname(report), { recursive: true, mode: 0o700 });
  await writeFile(report, JSON.stringify({ formatVersion: 1, passed: false, state: "incomplete" }) + "\n", { mode: 0o600 });
  signal.throwIfAborted();
  const sourceIdentity = await proofSource(source);
  const releaseIdentity = await proofSource(join(import.meta.dir, ".."));
  assert.deepEqual(releaseIdentity, packedSource, "Release source changed after producing the CLI archive");
  assert.match(archiveSha256, /^[a-f0-9]{64}$/);
  const tools = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")).devDependencies;
  const lintTools = JSON.parse(await readFile(join(import.meta.dir, "../lint/package.json"), "utf8")).dependencies;
  const storageDevice = await database.storageDevice();
  const machine = await referenceMachine(source, storageDevice, releaseIdentity.commit, await readFile(join(import.meta.dir, "../.github/workflows/native-setup.yml"), "utf8"));
  assert.equal(database.storage, "volume", "Reference commits require owned disk storage, never tmpfs");
  assert.ok(cpus().length >= 4 && machine.memoryBytes >= 16 * 1024 ** 3, "Reference machine needs four CPUs and 16 GiB");
  await writeFile(report, JSON.stringify({ formatVersion: 1, passed: false, state: "preflight", archiveSha256, source: { workout: sourceIdentity, fleur: releaseIdentity }, machine }, null, 2) + "\n", { mode: 0o600 });
  // Only this uniquely owned test database is changed. Remove the one functional-proof row.
  const removed = await database.sql`DELETE FROM exercises WHERE name='Production persistent squat' RETURNING id`;
  assert.equal(removed.length, 1);
  const fixture = await readFile(join(source, "benchmarks/workload.sql"), "utf8");
  await database.sql.unsafe(fixture);
  const settings = (await database.sql`SELECT current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit,current_setting('server_version') AS version`)[0];
  assert.equal(settings.fsync, "on"); assert.equal(settings.synchronous_commit, "on");
  const counts = await database.sql`SELECT (SELECT count(*)::int FROM exercises) AS exercises,(SELECT count(*)::int FROM workout_templates) AS templates,(SELECT count(*)::int FROM workout_sessions) AS sessions,(SELECT count(*)::int FROM workout_session_sets) AS sets`;
  assert.deepEqual({ ...counts[0] }, { exercises: 500, templates: 100, sessions: 10000, sets: 500000 });
  const limits: string[] = [];
  for (let repeat = 1; repeat <= 2; repeat++) limits.push(...(await workoutLimits(url, signal)).map(proof => `${proof}, repeat ${repeat}`));
  signal.throwIfAborted();
  const browserOwner = await proofBrowser(signal), browser = browserOwner.browser;
  const contexts: BrowserContext[] = [], pages: Page[] = [];
  const measurements: Record<string, ReferenceSample[][]> = Object.fromEntries(["query", "mutation", "crossView", "reconnect", "missedNotification", "burst"].map(name => [name, []]));
  const versions = new Map<number, number>(Array.from({ length: 10 }, (_, index) => [index + 1, 1]));
  const diagnostics: { scenario: string; run: number; sample: number; error: string }[] = [];
  const maxCommitUncertainty: number[] = [];
  async function mutation(key: number, name: string) {
    const started = performance.now();
    const response = await fetch(new URL("/__fleur/mutation", url), { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json", "x-fleur-request": "mutation" }, body: JSON.stringify({ name: "exercise.update", input: { id: id(key + 49), expectedVersion: versions.get(key), name } }), signal: AbortSignal.any([signal, AbortSignal.timeout(7000)]) });
    const result = await response.json();
    assert.equal(result.status, "success", "Reference mutation did not confirm commit");
    assert.equal(result.data.name, name); assert.equal(result.data.version, versions.get(key)! + 1); versions.set(key, result.data.version);
    const elapsed = performance.now() - started; maxCommitUncertainty.push(elapsed);
    return elapsed;
  }
  async function current(name: string, burst = false) {
    await Promise.all(pages.map(page => page.waitForFunction(({ name, burst, expectedVersions }) => {
      if (document.querySelector("#reference-state")?.textContent !== "current") return false;
      const list = [...document.querySelectorAll('[aria-label="List 0"] li')].map(row => row.textContent);
      if (!list.includes(`${name} v${expectedVersions[0]}`)) return false;
      return !burst || Array.from({ length: 9 }, (_, index) => `${name} ${index + 1} v${expectedVersions[index + 1]}`).every(value => list.includes(value));
    }, { name, burst, expectedVersions: Array.from({ length: 10 }, (_, index) => versions.get(index + 1)) }, { timeout: 7000, polling: "raf" })));
  }
  let releaseNotifications: (() => Promise<void>) | undefined;
  let evidence: { passed: boolean; [key: string]: unknown } | undefined;
  let originalError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    signal.throwIfAborted();
    for (let view = 0; view < 5; view++) {
      const context = await browser.newContext(), page = await context.newPage();
      contexts.push(context); pages.push(page);
      await page.goto(new URL(`/reference/${view}`, url).href);
      await expect(page.locator("#reference-state")).toHaveText("current", { timeout: 30000 });
      for (let list = 0; list < 5; list++) await expect(page.getByRole("region", { name: `List ${list}`, exact: true }).getByRole("listitem")).toHaveCount(100);
    }
    // Warm every logical key and the complete rendering path before measurement.
    for (const page of pages) { await page.getByRole("button", { name: "Refresh reference" }).click(); await expect(page.getByLabel("Query sample")).toHaveText("1"); }
    const loadBefore = loadavg();
    for (let run = 0; run < 3; run++) {
      const query: ReferenceSample[] = [], mutationSamples: ReferenceSample[] = [], crossView: ReferenceSample[] = [], reconnect: ReferenceSample[] = [], missed: ReferenceSample[] = [], burst: ReferenceSample[] = [];
      for (let sample = 0; sample < 100; sample++) {
        signal.throwIfAborted();
        const page = pages[sample % 5]!;
        const previous = Number(await page.getByLabel("Query sample").textContent());
        try {
          const milliseconds = await page.evaluate(async expected => {
            const started = performance.now();
            const changed = new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { observer.disconnect(); reject(new Error("Query render deadline")); }, 7000);
              const observer = new MutationObserver(() => {
                if (document.querySelector('[aria-label="Query sample"]')?.textContent === String(expected) && document.querySelector("#reference-state")?.textContent === "current") { clearTimeout(timer); observer.disconnect(); resolve(); }
              });
              observer.observe(document.body, { subtree: true, childList: true, characterData: true });
            });
            const button = [...document.querySelectorAll("button")].find(button => button.textContent === "Refresh reference");
            if (!button) throw new Error("Missing public refresh control"); button.click(); await changed;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return performance.now() - started;
          }, previous + 1);
          query.push({ milliseconds });
        } catch { query.push({ milliseconds: null, error: "QUERY_OBSERVATION_FAILED" }); diagnostics.push({ scenario: "query", run, sample, error: "QUERY_OBSERVATION_FAILED" }); }
      }
      for (let sample = 0; sample < 100; sample++) {
        signal.throwIfAborted();
        const started = performance.now(), name = `Reference ${run} ${sample}`;
        try {
          mutationSamples.push({ milliseconds: await mutation(1, name) });
          await current(name); crossView.push({ milliseconds: performance.now() - started });
        } catch {
          if (mutationSamples.length <= sample) mutationSamples.push({ milliseconds: null, error: "MUTATION_FAILED" });
          crossView.push({ milliseconds: null, error: "CROSS_VIEW_FAILED" }); diagnostics.push({ scenario: "sustained", run, sample, error: "MUTATION_OR_OBSERVATION_FAILED" });
        }
        // One submitted sustained commit per second; no retry of a failed intent.
        const remaining = 1000 - (performance.now() - started); if (remaining > 0) await Bun.sleep(remaining);
      }
      for (let sample = 0; sample < 100; sample++) {
        signal.throwIfAborted();
        try {
          await Promise.all(contexts.map(context => context.setOffline(true)));
          await Promise.all(pages.map(page => expect(page.locator("#reference-state")).toContainText("reconnecting", { timeout: 7000 })));
          const name = `Reconnect ${run} ${sample}`; await mutation(1, name);
          const restored = performance.now(); await Promise.all(contexts.map(context => context.setOffline(false)));
          await current(name); reconnect.push({ milliseconds: performance.now() - restored });
        } catch { reconnect.push({ milliseconds: null, error: "RECONNECT_FAILED" }); diagnostics.push({ scenario: "reconnect", run, sample, error: "RECONNECT_FAILED" }); }
        finally { await Promise.all(contexts.map(context => context.setOffline(false))); }
      }
      releaseNotifications = await database.pauseNotifications();
      try {
        for (let sample = 0; sample < 100; sample++) {
        signal.throwIfAborted();
          const started = performance.now(), name = `Missed ${run} ${sample}`;
          try { await mutation(1, name); await current(name); missed.push({ milliseconds: performance.now() - started }); }
          catch { missed.push({ milliseconds: null, error: "MISSED_NOTIFICATION_FAILED" }); diagnostics.push({ scenario: "missedNotification", run, sample, error: "MISSED_NOTIFICATION_FAILED" }); }
        }
      } finally { await releaseNotifications(); releaseNotifications = undefined; }
      for (let sample = 0; sample < 100; sample++) {
        signal.throwIfAborted();
        const started = performance.now(), name = `Burst ${run} ${sample}`;
        try {
          const submitted = Array.from({ length: 10 }, (_, key) => mutation(key + 1, key === 0 ? name : `${name} ${key}`));
          await Promise.all(submitted); await current(name, true);
          burst.push({ milliseconds: performance.now() - started });
        } catch { burst.push({ milliseconds: null, error: "BURST_FAILED" }); diagnostics.push({ scenario: "burst", run, sample, error: "BURST_FAILED" }); }
        const remaining = 1000 - (performance.now() - started); if (remaining > 0) await Bun.sleep(remaining);
      }
      for (const [name, samples] of Object.entries({ query, mutation: mutationSamples, crossView, reconnect, missedNotification: missed, burst })) measurements[name]!.push(samples);
      console.error(`Reference run ${run + 1}/3 completed with ${diagnostics.length} cumulative failures`);
    }
    const scenarios = Object.fromEntries(Object.entries({ query: 500, mutation: 500, crossView: 1000, reconnect: 2000, missedNotification: 5000, burst: 2000 }).map(([name, budget]) => [name, referenceScenario(measurements[name]!, budget)]));
    const docker = Bun.spawnSync(["docker", "info", "--format", "{{json .}}"], { stdout: "pipe", stderr: "pipe" }); assert.equal(docker.exitCode, 0);
    const allocation = JSON.parse(docker.stdout.toString());
    const manifest = JSON.parse(await readFile(join(artifact, "fleur-artifact.json"), "utf8"));
    assert.deepEqual(await proofSource(source), sourceIdentity, "Workout source changed during reference measurement");
    assert.deepEqual(await proofSource(join(import.meta.dir, "..")), releaseIdentity, "Release source changed during reference measurement");
    assert.equal(await database.storageDevice(), storageDevice, "Reference database backing device changed during measurement");
    const result = { formatVersion: 1, archiveSha256, source: { workout: sourceIdentity, fleur: releaseIdentity }, tools: { development: tools, independentLint: lintTools }, limits, passed: Object.values(scenarios).every(scenario => scenario.passed), scenarios, diagnostics, fixture: { sha256: Bun.CryptoHasher.hash("sha256", fixture, "hex"), ...counts[0] }, machine: { platform: platform(), ...machine, kernel: release(), cpu: cpus()[0]?.model, cores: cpus().length, docker: { cpu: allocation.NCPU, memoryBytes: allocation.MemTotal, engine: allocation.ServerVersion, kernel: allocation.KernelVersion }, browser: browser.version(), bun: Bun.version, artifact: manifest.id, images: manifest.images, postgres: { image: database.image, storage: database.storage, fsync: settings.fsync, synchronousCommit: settings.synchronous_commit, version: settings.version }, loadBefore, loadAfter: loadavg() }, measurement: { clock: "one driver performance.now clock; test-controlled names correlate committed rows with rendered values", warmup: "all 50 logical queries current, then one forced complete refresh per view; warm PostgreSQL and production runtime", commitObservation: "cross-view, missed and burst latencies are conservative upper bounds starting before submission; no unrelated wall-clock subtraction", maximumCommitUncertaintyMilliseconds: Math.max(...maxCommitUncertainty), notifications: "the one owned listener backend is stopped throughout each missed-publication run; authoritative probes must recover before delivery resumes", samplesPerRun: 100, independentRuns: 3, percentile: "nearest rank", errors: "infinite latency and run failure; never discarded", otherWork: "recorded load before and after; operator runs without unrelated heavy work", querySelection: "each view rotates through all five list and five detail keys; observation includes validated content and two rendering frames" } };
    evidence = result;
    assert.equal(result.passed, true, "Reference budgets failed; retained raw report is failure evidence");
  } catch (error) { originalError = error; }
  finally {
    for (const cleanup of [() => releaseNotifications?.(), ...contexts.map(context => () => closeProofContext(context)), () => browserOwner.close()]) try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
  }
  if (!evidence) await writeFile(report, JSON.stringify({ formatVersion: 1, passed: false, state: "incomplete", source: { workout: sourceIdentity, fleur: releaseIdentity }, measurements, diagnostics, disposal: { passed: cleanupErrors.length === 0 } }, null, 2) + "\n", { mode: 0o600 });
  if (evidence) await writeFile(report, JSON.stringify({ ...evidence, passed: evidence.passed && cleanupErrors.length === 0, disposal: { passed: cleanupErrors.length === 0 } }, null, 2) + "\n", { mode: 0o600 });
  if (originalError || cleanupErrors.length) throw new AggregateError([originalError, ...cleanupErrors].filter(Boolean), "Reference measurement or disposal failed");
}
