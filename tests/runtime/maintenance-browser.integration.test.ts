import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { compileClient } from "../../src/runtime/build/client";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";
import { serveReadApplication } from "../../src/runtime/http";
import { ownedPostgres } from "./owned-postgres";

test("browser reports maintenance, resumes after verified completion and startup rejects interrupted work", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/exercises", import.meta.url)));
  const bundle = await compileClient(project);
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  const root = await mkdtemp(join(tmpdir(), "fleur-maintenance-browser-"));
  const config = { stateRoot: root };
  let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let owner: MaintenanceLease | undefined;
  // Bounded failure trail: which operation failed, when, and with which code.
  const trace: unknown[] = [];
  const started = performance.now();
  let complete = false;
  try {
    await fixture.sql.unsafe("CREATE TABLE exercises (id uuid PRIMARY KEY,name text NOT NULL,note text,version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url, config);
    for (const name of ["revision", "render", "query"] as const) {
      const real = (app[name] as (...args: unknown[]) => Promise<unknown>).bind(app);
      (app as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        try { return await real(...args); }
        catch (error) { if (trace.length < 200) trace.push({ at: Math.round(performance.now() - started), op: name, error: error instanceof Error ? error.message : "non-error" }); throw error; }
      };
    }
    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (let repeat = 0; repeat < 2; repeat++) {
      owner = await MaintenanceLease.acquire(fixture.url, true, config);
      const response = await page.goto(server.url.origin+"/exercises");
      expect(response?.status()).toBe(503);
      await browserExpect(page.getByRole("heading", { name: "Database maintenance" })).toBeVisible();
      await owner.close(); owner = undefined;
      trace.push({ at: Math.round(performance.now() - started), released: repeat });
      await page.reload();
      await browserExpect(page.getByRole("heading", { name: "Exercises", exact: true })).toBeVisible();
    }
    owner = await MaintenanceLease.acquire(fixture.url, true, config);
    await owner.persist({ formatVersion: 1, target: owner.target, stage: "preparing", backup: null, planChecksum: "b".repeat(64), epoch: crypto.randomUUID() });
    await owner.close(); owner = undefined;
    await expect(ReadApplication.open(images, fixture.url, config)).rejects.toThrow("RECOVERY_REQUIRED");
    await page.reload();
    await browserExpect(page.getByText("Maintenance needs inspection before this application can resume.")).toBeVisible();
    complete = true;
  } finally {
    if (!complete) console.info("[maintenance-browser-diagnostics]", JSON.stringify({ trace, execution: app?.diagnostics() })); await owner?.close(); await browser?.close(); await server?.stop(true); await app?.close(); await fixture.cleanup(); await images.dispose(); await rm(root, { recursive: true, force: true }); }
}, 300_000);
