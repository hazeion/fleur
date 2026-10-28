import { expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Locator, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { compileClient } from "../../src/runtime/build/client";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { ReadApplication } from "../../src/runtime/application";
import { serveReadApplication } from "../../src/runtime/http";
import { ownedPostgres } from "./owned-postgres";

// Requirements: issue #31 browser criteria. Two views show complete server-content updates,
// failures stay safe and visible, and unsaved local drafts and focus survive refreshes.
const stored = (page: Page, name: string): Locator => page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
const editor = (page: Page, name: string): Locator => stored(page, name).getByRole("form", { name: "Edit template" });
async function fillEntry(form: Locator, position: number, exercise: string, sets: string, repetitions: string): Promise<void> {
  const entry = form.getByRole("group", { name: `Entry ${position}`, exact: true });
  await entry.getByLabel("Exercise").selectOption({ label: exercise });
  await entry.getByLabel("Sets").fill(sets);
  await entry.getByLabel("Repetitions").fill(repetitions);
}

test("two views create, reorder, conflict and deliberately reapply template drafts while keeping unsaved drafts and focus", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/workouts", import.meta.url)));
  const bundle = await compileClient(project);
  const source = [...bundle.files.values()].map(file => typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body)).join("\n");
  expect(source).not.toContain("server-private-canary");
  expect(source).not.toContain("database/broker");
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined, server: ReturnType<typeof serveReadApplication> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await fixture.reviewApplication(images, true);
    await fixture.sql.unsafe("INSERT INTO exercises(name) VALUES('Squat'),('Row'),('Bench press')");
    app = await ReadApplication.open(images, fixture.url);
    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    for (let repeat = 1; repeat <= 2; repeat++) {
      const first = await browser.newPage(), second = await browser.newPage();
      const errors: string[] = [];
      first.on("pageerror", error => errors.push(error.message)); second.on("pageerror", error => errors.push(error.message));
      for (const view of [first, second]) {
        await view.goto(server.url.origin + "/templates");
        await view.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      }
      const name = `Leg day ${repeat}`;
      const creator = first.getByRole("form", { name: "New template" });
      await creator.getByLabel("Template name").fill("   ");
      await fillEntry(creator, 1, "Squat", "3", "5");
      await creator.getByRole("button", { name: "Create template" }).click();
      await browserExpect(creator.getByRole("status")).toHaveText("INPUT_INVALID");
      await creator.getByLabel("Template name").fill(`  ${name}  `);
      await fillEntry(creator, 1, "Squat", "0", "5");
      await creator.getByRole("button", { name: "Create template" }).click();
      await browserExpect(creator.getByRole("status")).toHaveText("Not sent: INPUT_INVALID");
      await fillEntry(creator, 1, "Squat", "3", "5");
      await creator.getByRole("button", { name: "Add exercise" }).click();
      await fillEntry(creator, 2, "Row", "4", "8");
      await creator.getByRole("button", { name: "Create template" }).click();
      await browserExpect(creator.getByRole("status")).toHaveText("Saved");
      await browserExpect(creator.getByLabel("Template name")).toHaveValue("");

      // The other view receives the new template as server content, without navigation.
      await browserExpect(stored(second, name).getByRole("listitem")).toHaveText(["Squat: 3 × 5", "Row: 4 × 8"], { timeout: 15_000 });
      const draft = editor(second, name).getByLabel("Template name");
      await draft.fill(`Unsaved draft ${repeat}`);
      await draft.focus();
      await second.evaluate(() => { (globalThis as unknown as { originalDraft: Element | null }).originalDraft = document.activeElement; });

      const owner = editor(first, name);
      await owner.getByRole("group", { name: "Entry 2", exact: true }).getByRole("button", { name: "Move up" }).click();
      await owner.getByRole("button", { name: "Save template" }).click();
      await browserExpect(owner.getByRole("status")).toHaveText("Saved");
      await fillEntry(owner, 1, "Row", "5", "8");
      await owner.getByRole("button", { name: "Save template" }).click();
      await browserExpect(owner.getByRole("status")).toHaveText("Saved");
      await browserExpect(stored(first, name).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Server content in the second view follows each commit; its keyed draft island does not.
      await browserExpect(stored(second, name).getByRole("listitem")).toHaveText(["Row: 5 × 8", "Squat: 3 × 5"], { timeout: 15_000 });
      await browserExpect(stored(second, name).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });
      await browserExpect(draft).toHaveValue(`Unsaved draft ${repeat}`);
      await browserExpect(draft).toBeFocused();
      expect(await second.evaluate(() => (globalThis as unknown as { originalDraft: Element }).originalDraft === document.activeElement)).toBe(true);

      // The stale draft cannot overwrite the newer entries; the failure leaves the draft intact.
      await editor(second, name).getByRole("button", { name: "Save template" }).click();
      await browserExpect(editor(second, name).getByRole("status")).toContainText("VERSION_CONFLICT");
      await browserExpect(draft).toHaveValue(`Unsaved draft ${repeat}`);
      await browserExpect(stored(second, name).getByRole("listitem")).toHaveText(["Row: 5 × 8", "Squat: 3 × 5"]);
      await browserExpect(stored(first, name).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Deliberate recovery: rebase the kept draft onto the stored version, then save it.
      await editor(second, name).getByRole("button", { name: "Reapply draft to version 3" }).click();
      await browserExpect(draft).toHaveValue(`Unsaved draft ${repeat}`);
      await editor(second, name).getByRole("button", { name: "Save template" }).click();
      const rebased = `Unsaved draft ${repeat}`;
      await browserExpect(editor(second, rebased).getByRole("status")).toHaveText("Saved", { timeout: 15_000 });
      await browserExpect(stored(first, rebased).getByRole("listitem")).toHaveText(["Squat: 3 × 5", "Row: 4 × 8"], { timeout: 15_000 });
      await browserExpect(stored(first, rebased).getByText("Version 4", { exact: true })).toBeVisible({ timeout: 15_000 });
      expect(errors).toEqual([]);
      await first.close(); await second.close();
    }
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [() => browser?.close(), () => server?.stop(true), () => app?.close(), () => fixture.cleanup(), () => images.dispose()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    expect(failures, "Workout template browser fixture cleanup requires inspection").toEqual([]);
  }
}, 300_000);
