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

// Requirements: issues #32 and #102 browser criteria. Valid saves, client- and server-side rejection with
// unchanged drafts, history independence from later recipe changes, two-view server-content
// refresh with preserved drafts and focus, a stale-draft conflict that is deliberately reapplied,
// and deletion reaching the other view. Labels wrapping a control include its value in their text,
// so label lookups match by substring, as in the recipe browser test.
interface Ingredient { id: string; name: string }
const stored = (page: Page, date: string): Locator => page.getByRole("article").filter({ has: page.getByRole("heading", { name: `Meal on ${date}`, exact: true }) });
const editor = (page: Page, date: string): Locator => stored(page, date).getByRole("form", { name: "Edit meal" });
const ingredient = (form: Locator, position: number): Locator => form.getByRole("group", { name: `Ingredient ${position}`, exact: true });
const portion = (form: Locator, position: number, portionPosition: number): Locator => ingredient(form, position).getByRole("group", { name: `Portion ${portionPosition}`, exact: true });
async function fillPortion(form: Locator, position: number, portionPosition: number, count: string, amount: string, unit: "" | "g" | "ml"): Promise<void> {
  const target = portion(form, position, portionPosition);
  await target.getByLabel("Count").fill(count);
  await target.getByLabel("Amount").fill(amount);
  await target.getByLabel("Unit").selectOption(unit);
}

test("two views record, refresh, conflict, reapply and delete meal snapshots that later recipe changes cannot rewrite", async () => {
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
    const catalog = await app.query("ingredient.list", {}) as Ingredient[];
    const id = (name: string) => catalog.find(item => item.name === name)!.id;
    for (let repeat = 1; repeat <= 2; repeat++) {
      const recipeName = `Shortbread ${repeat}`, date = `2026-10-0${repeat}`;
      const recipe = await app.mutate("recipe.create", { name: recipeName, steps: [{ ingredientId: id("Flour"), targetPortions: 2, targetCount: 5 }, { ingredientId: id("Sugar"), targetPortions: 1, targetCount: 8 }] }) as { id: string };
      const first = await browser.newPage(), second = await browser.newPage();
      const errors: string[] = [];
      first.on("pageerror", error => errors.push(error.message)); second.on("pageerror", error => errors.push(error.message));
      for (const view of [first, second]) {
        await view.goto(server.url.origin + "/meals");
        await view.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      }
      const creator = first.getByRole("form", { name: "New meal" });
      const record = creator.getByRole("button", { name: "Record meal" }), status = creator.getByRole("status");
      await record.click();
      await browserExpect(status).toHaveText("Not sent: INPUT_INVALID");

      // Start from a recipe, then diverge from it: the meal snapshots what was used.
      await creator.getByLabel("Date").fill(date);
      await creator.getByLabel("Recipe").selectOption({ label: recipeName });
      await creator.getByRole("button", { name: "Use recipe" }).click();
      await browserExpect(creator.getByText(`Source recipe: ${recipeName}`)).toBeVisible();
      await browserExpect(ingredient(creator, 1).getByLabel("Ingredient")).toHaveValue("Flour");
      await browserExpect(ingredient(creator, 2).getByLabel("Ingredient")).toHaveValue("Sugar");
      await browserExpect(portion(creator, 1, 2).getByLabel("Count")).toHaveValue("5");
      await fillPortion(creator, 1, 1, "5", "62.50", "g");

      // A float artefact is refused before sending; an amount needs its unit; drafts are unchanged.
      await fillPortion(creator, 1, 2, "5", String(0.1 + 0.2), "g");
      await record.click();
      await browserExpect(status).toHaveText("Not sent: INPUT_INVALID");
      await browserExpect(portion(creator, 1, 2).getByLabel("Amount")).toHaveValue("0.30000000000000004");
      await fillPortion(creator, 1, 2, "5", "60", "");
      await record.click();
      await browserExpect(status).toHaveText("Not sent: enter both an amount and its unit, or neither.");
      // The server rejects an amount beyond the stored range; the submitted draft stays intact.
      await fillPortion(creator, 1, 2, "5", "100000", "g");
      await record.click();
      await browserExpect(status).toHaveText("INPUT_INVALID");
      await browserExpect(portion(creator, 1, 2).getByLabel("Amount")).toHaveValue("100000");
      await browserExpect(creator.getByLabel("Date")).toHaveValue(date);

      await fillPortion(creator, 1, 2, "5", "60.00", "ml");
      await ingredient(creator, 2).getByRole("button", { name: "Add portion" }).click();
      await fillPortion(creator, 2, 2, "6", "", "");
      await record.click();
      await browserExpect(status).toHaveText("Saved");
      await browserExpect(creator.getByLabel("Date")).toHaveValue("");

      const recorded = ["Flour: 5 pieces @ 62.5 g, 5 pieces @ 60 ml", "Sugar: 8 pieces, 6 pieces"];
      for (const view of [first, second]) {
        await browserExpect(stored(view, date).getByRole("listitem")).toHaveText(recorded, { timeout: 15_000 });
        await browserExpect(stored(view, date).getByText(`From recipe ${recipeName}`, { exact: true })).toBeVisible();
      }

      // Editing and then deleting the recipe refreshes both views without rewriting the meal.
      await app.mutate("recipe.update", { id: recipe.id, expectedVersion: 1, name: `Renamed ${repeat}`, steps: [{ ingredientId: id("Butter"), targetPortions: 9, targetCount: 9 }] });
      await browserExpect(creator.getByLabel("Recipe").getByRole("option", { name: `Renamed ${repeat}`, exact: true })).toHaveCount(1, { timeout: 15_000 });
      await app.mutate("recipe.delete", { id: recipe.id, expectedVersion: 2 });
      for (const view of [first, second]) {
        await browserExpect(view.getByRole("form", { name: "New meal" }).getByLabel("Recipe").getByRole("option", { name: `Renamed ${repeat}`, exact: true })).toHaveCount(0, { timeout: 15_000 });
        await browserExpect(stored(view, date).getByRole("listitem")).toHaveText(recorded);
        await browserExpect(stored(view, date).getByText(`From recipe ${recipeName}`, { exact: true })).toBeVisible();
      }

      // An unsaved draft in the second view keeps its value and focus while server content refreshes.
      const draft = portion(editor(second, date), 2, 2).getByLabel("Count");
      await draft.fill("7");
      await draft.focus();
      await second.evaluate(() => { (globalThis as unknown as { originalDraft: Element | null }).originalDraft = document.activeElement; });

      const owner = editor(first, date);
      await portion(owner, 1, 2).getByLabel("Amount").fill("61");
      await owner.getByRole("button", { name: "Save meal" }).click();
      await browserExpect(owner.getByRole("status")).toHaveText("Saved");
      const edited = ["Flour: 5 pieces @ 62.5 g, 5 pieces @ 61 ml", "Sugar: 8 pieces, 6 pieces"];
      await browserExpect(stored(second, date).getByRole("listitem")).toHaveText(edited, { timeout: 15_000 });
      await browserExpect(stored(second, date).getByText("Version 2", { exact: true })).toBeVisible({ timeout: 15_000 });
      await browserExpect(draft).toHaveValue("7");
      await browserExpect(draft).toBeFocused();
      expect(await second.evaluate(() => (globalThis as unknown as { originalDraft: Element }).originalDraft === document.activeElement)).toBe(true);

      // The stale draft cannot overwrite the newer meal; the failure keeps the draft.
      await editor(second, date).getByRole("button", { name: "Save meal" }).click();
      await browserExpect(editor(second, date).getByRole("status")).toContainText("VERSION_CONFLICT");
      await browserExpect(draft).toHaveValue("7");
      await browserExpect(stored(second, date).getByRole("listitem")).toHaveText(edited);

      // Deliberate recovery: rebase the kept draft onto the stored version, then save it.
      await editor(second, date).getByRole("button", { name: "Reapply draft to version 2" }).click();
      await browserExpect(draft).toHaveValue("7");
      await editor(second, date).getByRole("button", { name: "Save meal" }).click();
      await browserExpect(editor(second, date).getByRole("status")).toHaveText("Saved", { timeout: 15_000 });
      await browserExpect(stored(first, date).getByRole("listitem")).toHaveText(["Flour: 5 pieces @ 62.5 g, 5 pieces @ 60 ml", "Sugar: 8 pieces, 7 pieces"], { timeout: 15_000 });
      await browserExpect(stored(first, date).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Deleting with the current version removes the whole meal from the other view.
      await editor(second, date).getByRole("button", { name: "Delete meal" }).click();
      await browserExpect(stored(first, date)).toHaveCount(0, { timeout: 15_000 });
      await browserExpect(stored(second, date)).toHaveCount(0, { timeout: 15_000 });
      expect(errors).toEqual([]);
      await first.close(); await second.close();
    }
  } finally {
    const failures: unknown[] = [];
    for (const cleanup of [() => browser?.close(), () => server?.stop(true), () => app?.close(), () => fixture.cleanup(), () => images.dispose()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    expect(failures, "Meal browser fixture cleanup requires inspection").toEqual([]);
  }
}, 300_000);
