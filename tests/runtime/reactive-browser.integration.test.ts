import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { compileClient } from "../../src/runtime/build/client";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { serveReadApplication } from "../../src/runtime/http";
import { ownedPostgres } from "./owned-postgres";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";

test("two views refresh server regions and queries while retaining keyed drafts, focus and state", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/reactive", import.meta.url)));
  const bundle = await compileClient(project);
  expect([...bundle.files.values()].map(file => String(file.body)).join("\n")).not.toContain("reactive-server-secret-canary");
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let owner: MaintenanceLease | undefined;
  const trace: unknown[] = [];
  let complete = false;
  try {
    await fixture.reviewApplication(images, true);
    await fixture.sql.unsafe("INSERT INTO reactive_items(id,name) VALUES(1,'Alpha'),(2,'Beta')");
    app = await ReadApplication.open(images, fixture.url);
    const realQuery = app.query.bind(app), realRender = app.render.bind(app);
    app.query = async (...args) => { const start = performance.now(); try { return await realQuery(...args); } finally { trace.push({ op: "query", name: args[0], ms: Math.round(performance.now() - start) }); } };
    app.render = async (...args) => { const start = performance.now(); try { return await realRender(...args); } finally { trace.push({ op: "render", ms: Math.round(performance.now() - start) }); } };
    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    for (let repeat = 1; repeat <= 2; repeat++) {
      const first = await browser.newPage(), second = await browser.newPage();
      const errors: string[] = [];
      first.on("pageerror", error => errors.push(error.message)); second.on("pageerror", error => errors.push(error.message));
      const started = performance.now();
      second.on("response", async response => {
        if (!response.url().endsWith("/__fleur/view")) return;
        const result = await response.json().catch(() => null);
        trace.push({ at: Math.round(performance.now() - started), status: response.status(), revision: result?.revision, sequence: result?.sequence, generation: result?.generation, state: result?.status, renderError: result?.renderError, queries: result?.queries?.map((query: { name: string; status: string; stale: boolean }) => ({ name: query.name, status: query.status, stale: query.stale })) });
      });
      first.on("response", response => { if (response.url().endsWith("/__fleur/mutation")) trace.push({ at: Math.round(performance.now() - started), mutation: response.status() }); });
      await first.goto(server.url.origin + "/reactive"); await second.goto(server.url.origin + "/reactive");
      await browserExpect(second.getByLabel("List status")).toHaveText("success current");
      await browserExpect(first.getByLabel("List status")).toHaveText("success current");
      await browserExpect(first.getByLabel("Health status")).toHaveText("success Healthy", { timeout: 15_000 });
      await browserExpect(second.getByLabel("Health status")).toHaveText("success Healthy", { timeout: 15_000 });
      const draft = second.getByRole("textbox", { name: "Draft 1", exact: true });
      await draft.fill(`unsaved draft ${repeat}`);
      await second.getByRole("region", { name: "Draft 1", exact: true }).getByRole("button", { name: "Clicks 0" }).click();
      await draft.focus();
      await second.evaluate(() => { (globalThis as unknown as { originalDraft: Element | null }).originalDraft = document.activeElement; });
      await first.getByRole("textbox", { name: "Draft 1", exact: true }).fill(`Zulu ${repeat}`);
      await first.getByRole("button", { name: "Save 1", exact: true }).click();
      await browserExpect(first.getByLabel("Save status 1")).toHaveText("success", { timeout: 15_000 });
      await browserExpect(second.getByLabel("Live names")).toContainText(`Zulu ${repeat}`);
      await browserExpect(second.getByRole("region", { name: "Draft 1", exact: true })).toContainText(`Stored: Zulu ${repeat}`);
      await browserExpect(draft).toHaveValue(`unsaved draft ${repeat}`);
      await browserExpect(draft).toBeFocused();
      expect(await second.evaluate(() => (globalThis as unknown as { originalDraft: Element }).originalDraft === document.activeElement)).toBe(true);
      await browserExpect(second.getByRole("region", { name: "Draft 1", exact: true })).toContainText("Clicks 1");
      await browserExpect(second.getByRole("region", { name: "Draft 1", exact: true })).toContainText("Mounts 1");
      await second.getByRole("button", { name: "Large query" }).click();
      await browserExpect(second.getByLabel("Health status")).toContainText("RESULT_TOO_LARGE", { timeout: 15_000 });
      await browserExpect(second.getByLabel("List status")).toHaveText("success current");
      await second.getByRole("button", { name: "Slow query" }).click();
      await browserExpect(second.getByLabel("Health status")).toContainText("QUERY_TIMEOUT", { timeout: 20_000 });
      await second.getByRole("button", { name: "Healthy query" }).click();
      await browserExpect(second.getByLabel("Health status")).toHaveText("success Healthy", { timeout: 20_000 });
      await second.context().setOffline(true);
      await browserExpect(second.getByLabel("List status")).toContainText("reconnecting");
      await first.getByRole("textbox", { name: "Draft 2", exact: true }).fill(`Changed offline ${repeat}`);
      await first.getByRole("button", { name: "Save 2", exact: true }).click();
      await browserExpect(first.getByLabel("Save status 2")).toHaveText("success", { timeout: 15_000 });
      await second.context().setOffline(false);
      await browserExpect(second.getByLabel("Live names")).toContainText(`Changed offline ${repeat}`, { timeout: 20_000 });
      await browserExpect(second.getByLabel("List status")).toHaveText("success current");
      owner = await MaintenanceLease.acquire(fixture.url, true);
      await browserExpect(second.getByLabel("List status")).toContainText("maintenance", { timeout: 15_000 });
      await owner.close(); owner = undefined;
      await browserExpect(second.getByLabel("List status")).toHaveText("success current", { timeout: 20_000 });
      await second.getByRole("link", { name: "Other page" }).click();
      await browserExpect(second.getByRole("heading", { name: "Other page" })).toBeVisible();
      expect(errors).toEqual([]);
      await first.close(); await second.close();
    }
    complete = true;
  } finally {
    if (!complete) console.info("[reactive-refresh-diagnostics]", JSON.stringify(trace));
    const failures: unknown[] = [];
    for (const cleanup of [() => owner?.close(), () => browser?.close(), () => server?.stop(true), () => app?.close(), () => fixture.cleanup(), () => images.dispose()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    // Preserve the original test outcome while surfacing every cleanup failure.
    expect(failures, "Reactive fixture cleanup requires inspection").toEqual([]);
  }
}, 300_000);
