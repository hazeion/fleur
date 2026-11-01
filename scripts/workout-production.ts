import assert from "node:assert/strict";
import type { proofSource } from "./proof-source";
import { stopProofProcess, finishProofOutput } from "./proof-process";
import { proofBrowser, usingProofContext } from "./proof-browser";
import { workoutReference } from "./workout-reference";
import { cp, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { ownedPostgres } from "../tests/runtime/owned-postgres";

interface Options {
  root: string;
  app: string;
  executable: string;
  environment: Record<string, string | undefined>;
  children: Set<ReturnType<typeof Bun.spawn>>;
  signal: AbortSignal;
  reference?: { source: string; report: string; archiveSha256: string; releaseSource: Awaited<ReturnType<typeof proofSource>> };
}
/** Test orchestration only. Application modules still use only Fleur's public APIs. */
export async function workoutProduction(options: Options): Promise<{ checks: string[]; coldStartMilliseconds: number[]; artifact: Record<string, unknown> }> {
  const { root, app, executable, environment, children } = options;
  options.signal.throwIfAborted();
  const database = await ownedPostgres(options.reference ? { disk: true } : {});
  let browser: Browser | undefined;
  let browserOwner: Awaited<ReturnType<typeof proofBrowser>> | undefined;
  const launchers: ReturnType<typeof Bun.spawn>[] = [];
  const checks: string[] = [];
  const coldStartMilliseconds: number[] = [];
  const productionEnvironment: Record<string, string | undefined> = { ...environment, FLEUR_PRIVATE_DATABASE_URL: database.url, FLEUR_PRIVATE_STATE_ROOT: join(root, "production-state"), FLEUR_PRIVATE_PG_TOOLS: undefined };
  async function finite(args: string[], cwd: string) {
    const child = Bun.spawn([process.execPath, executable, ...args, "--project", cwd, "--json", "--timeout", "240"], { detached: true, cwd, env: productionEnvironment, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" });
    children.add(child);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    children.delete(child);
    assert.equal(exit, 0, `Production maintenance failed: ${stdout} ${stderr}`);
    return JSON.parse(stdout);
  }
  let artifact: string | undefined;
  let artifactEvidence: Record<string, unknown> | undefined;
  const interrupted = () => { for (const child of launchers) child.kill("SIGTERM"); };
  options.signal.addEventListener("abort", interrupted, { once: true });
  let originalError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    options.signal.throwIfAborted();
    productionEnvironment.FLEUR_PRIVATE_PG_TOOLS = await database.pgTools(join(root, "production-tools"));
    const migrationProject = join(root, "operator");
    await mkdir(migrationProject);
    for (const directory of ["server", "shared", "client", "migrations"]) await cp(join(app, directory), join(migrationProject, directory), { recursive: true });
    await cp(join(app, "fleur.json"), join(migrationProject, "fleur.json"));
    await finite(["db", "migration", "apply"], migrationProject);
    const artifacts = (await readdir(join(app, ".fleur/artifacts"))).filter(name => !name.startsWith("."));
    assert.equal(artifacts.length, 1);
    artifact = join(root, "clean-artifact");
    await rename(join(app, ".fleur/artifacts", artifacts[0]!), artifact);
    // The production server cannot rely on application sources, node_modules or their caches.
    await rename(app, `${app}-away`);
    const publishedArtifact = artifact;
    browserOwner = await proofBrowser(options.signal); browser = browserOwner.browser;
    for (let repeat = 1; repeat <= 2; repeat++) {
      options.signal.throwIfAborted();
      const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = portProbe.port; await portProbe.stop(true);
      const launchStarted = performance.now();
      const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn([process.execPath, executable.replace(app, `${app}-away`), "start", "--artifact", artifact, "--port", String(port), "--timeout", "240", "--json"], { detached: true, cwd: root, env: productionEnvironment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      children.add(child); launchers.push(child);
      let ready!: (url: string) => void, refused!: (error: unknown) => void;
      const readiness = new Promise<string>((resolve, reject) => { ready = resolve; refused = reject; });
      const events: { formatVersion: number; command: string; sequence: number; event: string; data: { url?: string; exitCode?: number; result?: { ok: boolean } } }[] = [];
      const outputReader = child.stdout.getReader();
      const received = (async () => {
        let pending = "";
        for (;;) {
          const next = await outputReader.read(); if (next.done) break;
          pending += new TextDecoder().decode(next.value);
          const lines = pending.split("\n"); pending = lines.pop()!;
          for (const line of lines) {
            const event = JSON.parse(line);
            assert.equal(event.formatVersion, 1); assert.equal(event.command, "start"); assert.equal(event.sequence, events.length);
            events.push(event); if (event.event === "ready") ready(event.data.url);
          }
        }
        assert.equal(pending, "");
        if (!events.some(event => event.event === "ready")) throw new Error(`Production exited before readiness: ${JSON.stringify(events.at(-1) ?? null)}`);
      })().catch(error => { refused(error); throw error; });
      // Register rejection handlers immediately, including startup failure before readiness.
      void received.catch(() => {});
      let runError: unknown;
      const failures: unknown[] = [];
      const timer = setTimeout(() => { refused(new Error("Production readiness deadline expired")); child.kill("SIGTERM"); }, 250_000);
      try {
        const url = await readiness;
        coldStartMilliseconds.push(performance.now() - launchStarted);
        await usingProofContext(browser, async context => {
          const page: Page = await context.newPage();
          await page.goto(url);
          if (repeat === 1) {
            const form = page.getByRole("form", { name: "New exercise" });
            await form.getByLabel("Exercise name").fill("Production persistent squat");
            await form.getByRole("button", { name: "Create exercise" }).click();
            await expect(form.getByRole("status")).toHaveText("Saved");
          }
          await expect(page.getByRole("heading", { name: "Production persistent squat", exact: true })).toBeVisible({ timeout: 15_000 });
          assert.equal((await fetch(new URL("/__fleur/health", url), { signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) })).status, 200);
          assert.equal((await page.content()).includes(database.url), false);
          assert.equal((await page.content()).includes("fleur-development"), false);
          if (repeat === 2 && options.reference) {
            const identity = await page.locator("#fleur-view").textContent();
            assert.ok(identity);
            const view = JSON.parse(identity);
            const disposed = await fetch(new URL("/__fleur/view", url), { method: "POST", headers: { origin: new URL(url).origin, "x-fleur-request": "view", "content-type": "application/json" }, signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]), body: JSON.stringify({ action: "dispose", connection: view.connection, page: view.page }) });
            assert.equal(disposed.ok, true); await page.close();
            await workoutReference({ url, artifact: publishedArtifact, database, signal: options.signal, ...options.reference });
            checks.push("three independent production reference runs per scenario, 100 samples/run");
          }
          checks.push(`clean production artifact serves public browser save/read and persistent restart, repeat ${repeat}`);
        });
      } catch (error) { runError = error; } finally {
        clearTimeout(timer);
        if (runError) failures.push(runError);
        let exit: number | undefined;
        try { exit = await stopProofProcess(child, repeat === 1 ? "SIGTERM" : "SIGINT"); } catch (error) { failures.push(error); }
        try { await finishProofOutput(received, () => outputReader.cancel()); } catch (error) { failures.push(error); }
        try {
          assert.equal(exit, 0);
          const completed = events.at(-1)!; assert.equal(completed.event, "completed"); assert.equal(completed.data.exitCode, 0); assert.equal(completed.data.result?.ok, true);
        } catch (error) { failures.push(error); }
        if (child.exitCode !== null || child.signalCode !== null) children.delete(child);
      }
      if (failures.length) throw new AggregateError(failures, "Production run or graceful completion failed");
    }
    // Archive presence is independently checked; no source-relative path is used by start.
    const verifiedManifest = JSON.parse(await readFile(join(artifact, "fleur-artifact.json"), "utf8"));
    artifactEvidence = { id: verifiedManifest.id, fleurVersion: verifiedManifest.fleurVersion, images: verifiedManifest.images };
  } catch (error) { originalError = error; }
  finally {
    for (const child of launchers) {
      try { await stopProofProcess(child, "SIGTERM"); } catch (error) { cleanupErrors.push(error); }
      if (child.exitCode !== null || child.signalCode !== null) children.delete(child);
    }
    const retireImages = async () => {
      if (!artifact) return;
      const manifest = JSON.parse(await readFile(join(artifact, "fleur-artifact.json"), "utf8"));
      for (const role of [manifest.images.worker, manifest.images.controller]) {
        const active = Bun.spawn(["docker", "ps", "--all", "--quiet", "--filter", `ancestor=${role.tag}`], { stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" });
        const containers = (await new Response(active.stdout).text()).trim();
        assert.equal(await active.exited, 0); assert.equal(containers, "", "Owned execution containers survived graceful completion");
        const listed = Bun.spawn(["docker", "image", "ls", "--quiet", "--filter", `reference=${role.tag}`], { stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" });
        const present = (await new Response(listed.stdout).text()).trim(); assert.equal(await listed.exited, 0);
        if (!present) continue;
        const inspect = Bun.spawn(["docker", "image", "inspect", role.tag], { stdout: "pipe", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" });
        const metadata = JSON.parse(await new Response(inspect.stdout).text())[0]; assert.equal(await inspect.exited, 0);
        assert.ok(role.identities.includes(metadata.Id));
        const owner = metadata.Config.Labels["dev.fleur.read-image-owner"]; assert.equal(typeof owner, "string"); assert.ok(role.tag.includes(owner));
        const removed = Bun.spawn(["docker", "image", "rm", role.tag], { stdout: "ignore", stderr: "pipe", timeout: 30000, killSignal: "SIGKILL" }); assert.equal(await removed.exited, 0);
      }
    };
    for (const cleanup of [() => browserOwner?.close(), () => database.cleanup(), retireImages]) try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    options.signal.removeEventListener("abort", interrupted);
    // Restore the disposable source only so its ordinary dev cleanup can verify ownership.
    try { await rename(`${app}-away`, app); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(error); }
  }
  if (originalError || cleanupErrors.length) throw new AggregateError([originalError, ...cleanupErrors].filter(Boolean), "Production acceptance or cleanup failed");
  assert.ok(artifactEvidence);
  return { artifact: artifactEvidence, checks: [...checks, "production database retired after graceful completed events"], coldStartMilliseconds };
}
