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

// Requirements: issue #32 browser criteria. Valid saves, client- and server-side rejection with
// unchanged drafts, history independence from later template changes, two-view server-content
// refresh with preserved drafts and focus, a stale-draft conflict that is deliberately reapplied,
// and deletion reaching the other view. Labels wrapping a control include its value in their text,
// so label lookups match by substring, as in the template browser test.
interface Exercise { id: string; name: string }
const stored = (page: Page, date: string): Locator => page.getByRole("article").filter({ has: page.getByRole("heading", { name: `Session on ${date}`, exact: true }) });
const editor = (page: Page, date: string): Locator => stored(page, date).getByRole("form", { name: "Edit session" });
const exercise = (form: Locator, position: number): Locator => form.getByRole("group", { name: `Exercise ${position}`, exact: true });
const workoutSet = (form: Locator, position: number, setPosition: number): Locator => exercise(form, position).getByRole("group", { name: `Set ${setPosition}`, exact: true });
async function fillSet(form: Locator, position: number, setPosition: number, repetitions: string, weight: string, unit: "" | "kg" | "lb"): Promise<void> {
  const target = workoutSet(form, position, setPosition);
  await target.getByLabel("Repetitions").fill(repetitions);
  await target.getByLabel("Weight").fill(weight);
  await target.getByLabel("Unit").selectOption(unit);
}

test("two views record, refresh, conflict, reapply and delete session snapshots that later template changes cannot rewrite", async () => {
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
    const catalog = await app.query("exercise.list", {}) as Exercise[];
    const id = (name: string) => catalog.find(item => item.name === name)!.id;
    for (let repeat = 1; repeat <= 2; repeat++) {
      const templateName = `Leg day ${repeat}`, date = `2026-10-0${repeat}`;
      const template = await app.mutate("template.create", { name: templateName, entries: [{ exerciseId: id("Squat"), targetSets: 2, targetRepetitions: 5 }, { exerciseId: id("Row"), targetSets: 1, targetRepetitions: 8 }] }) as { id: string };
      const first = await browser.newPage(), second = await browser.newPage();
      const errors: string[] = [];
      first.on("pageerror", error => errors.push(error.message)); second.on("pageerror", error => errors.push(error.message));
      for (const view of [first, second]) {
        await view.goto(server.url.origin + "/sessions");
        await view.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      }
      const creator = first.getByRole("form", { name: "New session" });
      const record = creator.getByRole("button", { name: "Record session" }), status = creator.getByRole("status");
      await record.click();
      await browserExpect(status).toHaveText("Not sent: INPUT_INVALID");

      // Start from a template, then diverge from it: the session snapshots what was performed.
      await creator.getByLabel("Date").fill(date);
      await creator.getByLabel("Template").selectOption({ label: templateName });
      await creator.getByRole("button", { name: "Use template" }).click();
      await browserExpect(creator.getByText(`Source template: ${templateName}`)).toBeVisible();
      await browserExpect(exercise(creator, 1).getByLabel("Exercise")).toHaveValue("Squat");
      await browserExpect(exercise(creator, 2).getByLabel("Exercise")).toHaveValue("Row");
      await browserExpect(workoutSet(creator, 1, 2).getByLabel("Repetitions")).toHaveValue("5");
      await fillSet(creator, 1, 1, "5", "62.50", "kg");

      // A float artefact is refused before sending; a weight needs its unit; drafts are unchanged.
      await fillSet(creator, 1, 2, "5", String(0.1 + 0.2), "kg");
      await record.click();
      await browserExpect(status).toHaveText("Not sent: INPUT_INVALID");
      await browserExpect(workoutSet(creator, 1, 2).getByLabel("Weight")).toHaveValue("0.30000000000000004");
      await fillSet(creator, 1, 2, "5", "60", "");
      await record.click();
      await browserExpect(status).toHaveText("Not sent: enter both a weight and its unit, or neither.");
      // The server rejects a weight beyond the stored range; the submitted draft stays intact.
      await fillSet(creator, 1, 2, "5", "100000", "kg");
      await record.click();
      await browserExpect(status).toHaveText("INPUT_INVALID");
      await browserExpect(workoutSet(creator, 1, 2).getByLabel("Weight")).toHaveValue("100000");
      await browserExpect(creator.getByLabel("Date")).toHaveValue(date);

      await fillSet(creator, 1, 2, "5", "60.00", "lb");
      await exercise(creator, 2).getByRole("button", { name: "Add set" }).click();
      await fillSet(creator, 2, 2, "6", "", "");
      await record.click();
      await browserExpect(status).toHaveText("Saved");
      await browserExpect(creator.getByLabel("Date")).toHaveValue("");

      const recorded = ["Squat: 5 reps @ 62.5 kg, 5 reps @ 60 lb", "Row: 8 reps, 6 reps"];
      for (const view of [first, second]) {
        await browserExpect(stored(view, date).getByRole("listitem")).toHaveText(recorded, { timeout: 15_000 });
        await browserExpect(stored(view, date).getByText(`From template ${templateName}`, { exact: true })).toBeVisible();
      }

      // Editing and then deleting the template refreshes both views without rewriting the session.
      await app.mutate("template.update", { id: template.id, expectedVersion: 1, name: `Renamed ${repeat}`, entries: [{ exerciseId: id("Bench press"), targetSets: 9, targetRepetitions: 9 }] });
      await browserExpect(creator.getByLabel("Template").getByRole("option", { name: `Renamed ${repeat}`, exact: true })).toHaveCount(1, { timeout: 15_000 });
      await app.mutate("template.delete", { id: template.id, expectedVersion: 2 });
      for (const view of [first, second]) {
        await browserExpect(view.getByRole("form", { name: "New session" }).getByLabel("Template").getByRole("option", { name: `Renamed ${repeat}`, exact: true })).toHaveCount(0, { timeout: 15_000 });
        await browserExpect(stored(view, date).getByRole("listitem")).toHaveText(recorded);
        await browserExpect(stored(view, date).getByText(`From template ${templateName}`, { exact: true })).toBeVisible();
      }

      // An unsaved draft in the second view keeps its value and focus while server content refreshes.
      const draft = workoutSet(editor(second, date), 2, 2).getByLabel("Repetitions");
      await draft.fill("7");
      await draft.focus();
      await second.evaluate(() => { (globalThis as unknown as { originalDraft: Element | null }).originalDraft = document.activeElement; });

      const owner = editor(first, date);
      await workoutSet(owner, 1, 2).getByLabel("Weight").fill("61");
      await owner.getByRole("button", { name: "Save session" }).click();
      await browserExpect(owner.getByRole("status")).toHaveText("Saved");
      const edited = ["Squat: 5 reps @ 62.5 kg, 5 reps @ 61 lb", "Row: 8 reps, 6 reps"];
      await browserExpect(stored(second, date).getByRole("listitem")).toHaveText(edited, { timeout: 15_000 });
      await browserExpect(stored(second, date).getByText("Version 2", { exact: true })).toBeVisible({ timeout: 15_000 });
      await browserExpect(draft).toHaveValue("7");
      await browserExpect(draft).toBeFocused();
      expect(await second.evaluate(() => (globalThis as unknown as { originalDraft: Element }).originalDraft === document.activeElement)).toBe(true);

      // The stale draft cannot overwrite the newer session; the failure keeps the draft.
      await editor(second, date).getByRole("button", { name: "Save session" }).click();
      await browserExpect(editor(second, date).getByRole("status")).toContainText("VERSION_CONFLICT");
      await browserExpect(draft).toHaveValue("7");
      await browserExpect(stored(second, date).getByRole("listitem")).toHaveText(edited);

      // Deliberate recovery: rebase the kept draft onto the stored version, then save it.
      await editor(second, date).getByRole("button", { name: "Reapply draft to version 2" }).click();
      await browserExpect(draft).toHaveValue("7");
      await editor(second, date).getByRole("button", { name: "Save session" }).click();
      await browserExpect(editor(second, date).getByRole("status")).toHaveText("Saved", { timeout: 15_000 });
      await browserExpect(stored(first, date).getByRole("listitem")).toHaveText(["Squat: 5 reps @ 62.5 kg, 5 reps @ 60 lb", "Row: 8 reps, 7 reps"], { timeout: 15_000 });
      await browserExpect(stored(first, date).getByText("Version 3", { exact: true })).toBeVisible({ timeout: 15_000 });

      // Deleting with the current version removes the whole session from the other view.
      await editor(second, date).getByRole("button", { name: "Delete session" }).click();
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
    expect(failures, "Workout session browser fixture cleanup requires inspection").toEqual([]);
  }
}, 300_000);
