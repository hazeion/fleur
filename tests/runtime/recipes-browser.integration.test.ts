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

// Requirements: issues #31 and #102 browser criteria. Two views show complete server-content updates,
// failures stay safe and visible, and unsaved local drafts and focus survive refreshes.
const stored = (page: Page, name: string): Locator => page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
const editor = (page: Page, name: string): Locator => stored(page, name).getByRole("form", { name: "Edit recipe" });
async function fillStep(form: Locator, position: number, ingredient: string, portions: string, count: string): Promise<void> {
  const step = form.getByRole("group", { name: `Step ${position}`, exact: true });
  await step.getByLabel("Ingredient").selectOption({ label: ingredient });
  await step.getByLabel("Portions").fill(portions);
  await step.getByLabel("Count").fill(count);
}

test("two views create, reorder, conflict and deliberately reapply recipe drafts while keeping unsaved drafts and focus", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/recipes", import.meta.url)));
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
    await fixture.sql.unsafe("INSERT INTO ingredients(name) VALUES('Flour'),('Sugar'),('Butter')");
    app = await ReadApplication.open(images, fixture.url);
    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    for (let repeat = 1; repeat <= 2; repeat++) {
      const first = await browser.newPage(), second = await browser.newPage();
      const errors: string[] = [];
      first.on("pageerror", error => errors.push(error.message)); second.on("pageerror", error => errors.push(error.message));
      for (const view of [first, second]) {
        await view.goto(server.url.origin + "/recipes");
        await view.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      }
      const name = `Shortbread ${repeat}`;
      const creator = first.getByRole("form", { name: "New recipe" });
      await creator.getByLabel("Recipe name").fill("   ");
      await fillStep(creator, 1, "Flour", "3", "5");
      await creator.getByRole("button", { name: "Create recipe" }).click();
      await browserExpect(creator.getByRole("status")).toHaveText("INPUT_INVALID");
      await creator.getByLabel("Recipe name").fill(`  ${name}  `);
      await fillStep(creator, 1, "Flour", "0", "5");
      await creator.getByRole("button", { name: "Create recipe" }).click();
      await browserExpect(creator.getByRole("status")).toHaveText("Not sent: INPUT_INVALID");
      await fillStep(creator, 1, "Flour", "3", "5");
      await creator.getByRole("button", { name: "Add ingredient" }).click();
      await fillStep(creator, 2, "Sugar", "4", "8");
      await creator.getByRole("button", { name: "Create recipe" }).click();
      await browserExpect(creator.getByRole("status")).toHaveText("Saved");
      await browserExpect(creator.getByLabel("Recipe name")).toHaveValue("");

      // The other view receives the new recipe as server content, without navigation.
      await browserExpect(stored(second, name).getByRole("listitem")).toHaveText(["Flour: 3 × 5", "Sugar: 4 × 8"], { timeout: 15_000 });
      const draft = editor(second, name).getByLabel("Recipe name");
      await draft.fill(`Unsaved draft ${repeat}`);
      await draft.focus();
      await second.evaluate(() => { (globalThis as unknown as { originalDraft: Element | null }).originalDraft = document.activeElement; });

      const owner = editor(first, name);
      await owner.getByRole("group", { name: "Step 2", exact: true }).getByRole("button", { name: "Move up" }).click();
      await owner.getByRole("button", { name: "Save recipe" }).click();
      await browserExpect(owner.getByRole("status")).toHaveText("Saved");
      await fillStep(owner, 1, "Sugar", "5", "8");
      await owner.getByRole("button", { name: "Save recipe" }).click();
      await browserExpect(owner.getByRole("status")).toHaveText("Saved");
      await browserExpect(stored(first, name).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Server content in the second view follows each commit; its keyed draft island does not.
      await browserExpect(stored(second, name).getByRole("listitem")).toHaveText(["Sugar: 5 × 8", "Flour: 3 × 5"], { timeout: 15_000 });
      await browserExpect(stored(second, name).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });
      await browserExpect(draft).toHaveValue(`Unsaved draft ${repeat}`);
      await browserExpect(draft).toBeFocused();
      expect(await second.evaluate(() => (globalThis as unknown as { originalDraft: Element }).originalDraft === document.activeElement)).toBe(true);

      // The stale draft cannot overwrite the newer steps; the failure leaves the draft intact.
      await editor(second, name).getByRole("button", { name: "Save recipe" }).click();
      await browserExpect(editor(second, name).getByRole("status")).toContainText("VERSION_CONFLICT");
      await browserExpect(draft).toHaveValue(`Unsaved draft ${repeat}`);
      await browserExpect(stored(second, name).getByRole("listitem")).toHaveText(["Sugar: 5 × 8", "Flour: 3 × 5"]);
      await browserExpect(stored(first, name).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Deliberate recovery: rebase the kept draft onto the stored version, then save it.
      await editor(second, name).getByRole("button", { name: "Reapply draft to version 3" }).click();
      await browserExpect(draft).toHaveValue(`Unsaved draft ${repeat}`);
      await editor(second, name).getByRole("button", { name: "Save recipe" }).click();
      const rebased = `Unsaved draft ${repeat}`;
      await browserExpect(editor(second, rebased).getByRole("status")).toHaveText("Saved", { timeout: 15_000 });
      await browserExpect(stored(first, rebased).getByRole("listitem")).toHaveText(["Flour: 3 × 5", "Sugar: 4 × 8"], { timeout: 15_000 });
      await browserExpect(stored(first, rebased).getByText("Version 4", { exact: true })).toBeVisible({ timeout: 15_000 });
      expect(errors).toEqual([]);
      await first.close(); await second.close();
    }
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [() => browser?.close(), () => server?.stop(true), () => app?.close(), () => fixture.cleanup(), () => images.dispose()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    expect(failures, "Recipe browser fixture cleanup requires inspection").toEqual([]);
  }
}, 300_000);
