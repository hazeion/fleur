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
  try {
    await fixture.sql.unsafe("CREATE TABLE exercises (id uuid PRIMARY KEY,name text NOT NULL,note text,version bigint NOT NULL DEFAULT 1)");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url, config);
    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    for (let repeat = 0; repeat < 2; repeat++) {
      owner = await MaintenanceLease.acquire(fixture.url, true, config);
      const response = await page.goto(server.url.origin+"/exercises");
      expect(response?.status()).toBe(503);
      await browserExpect(page.getByRole("heading", { name: "Database maintenance" })).toBeVisible();
      await owner.close(); owner = undefined;
      await page.reload();
      await browserExpect(page.getByRole("heading", { name: "Exercises", exact: true })).toBeVisible();
    }
    owner = await MaintenanceLease.acquire(fixture.url, true, config);
    await owner.persist({ formatVersion: 1, target: owner.target, stage: "preparing", backup: null, planChecksum: "b".repeat(64), epoch: crypto.randomUUID() });
    await owner.close(); owner = undefined;
    await expect(ReadApplication.open(images, fixture.url, config)).rejects.toThrow("RECOVERY_REQUIRED");
    await page.reload();
    await browserExpect(page.getByText("Maintenance needs inspection before this application can resume.")).toBeVisible();
  } finally { await owner?.close(); await browser?.close(); await server?.stop(true); await app?.close(); await fixture.cleanup(); await images.dispose(); await rm(root, { recursive: true, force: true }); }
}, 300_000);
