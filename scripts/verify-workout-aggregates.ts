// Trusted regression fixture. The application itself imports only Fleur's public API.
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { admitProject } from "../src/runtime/build/admission";
import { proofBrowser, usingProofContext } from "./proof-browser";
import { expect } from "@playwright/test";
import { compileClient } from "../src/runtime/build/client";
import { serveReadApplication } from "../src/runtime/http";
import { compileWorker } from "../src/runtime/build/worker";
import { prepareNativeImages } from "../src/runtime/native/build";
import { ReadApplication } from "../src/runtime/application";
import { ownedPostgres } from "../tests/runtime/owned-postgres";
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/verify-workout-aggregates.ts <workout-checkout>");
const root = await mkdtemp(join(tmpdir(), "fleur-aggregate-proof-"));
let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
let database: Awaited<ReturnType<typeof ownedPostgres>> | undefined;
let application: ReadApplication | undefined;
let server: ReturnType<typeof serveReadApplication> | undefined;
let browser: Awaited<ReturnType<typeof proofBrowser>> | undefined;
let failure: unknown;
const cleanupFailures: unknown[] = [];
try {
  for (const directory of ["client", "server", "shared"]) await cp(join(source, directory), join(root, directory), { recursive: true });
  for (const file of ["package.json", "fleur.json"]) await cp(join(source, file), join(root, file));
  await symlink(join(source, "node_modules"), join(root, "node_modules"));
  for (const [from, to] of [["contracts.ts", "shared/reference.ts"], ["View.tsx", "client/ReferenceView.tsx"], ["server.tsx", "server/reference.tsx"]]) await cp(join(source, "benchmarks", from!), join(root, to!));
  const bundle = await compileWorker(await admitProject(root));
  images = await prepareNativeImages(bundle);
  database = await ownedPostgres(); await database.reviewApplication(images, true);
  await database.sql.unsafe(`INSERT INTO exercises(id,name) VALUES('00000000-0000-4000-8000-000000000001','Squat');
INSERT INTO workout_templates(id,name) VALUES('00000000-0000-4000-8000-000000000002','Large template');
INSERT INTO workout_template_entries("templateId",position,"exerciseId","targetSets","targetRepetitions") SELECT '00000000-0000-4000-8000-000000000002',i,'00000000-0000-4000-8000-000000000001',1,i+1 FROM generate_series(0,500) i;
INSERT INTO workout_sessions(id,date) VALUES('00000000-0000-4000-8000-000000000003','2026-01-01');
INSERT INTO workout_session_exercises(id,"sessionId",position,name) VALUES('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003',0,'Squat');
INSERT INTO workout_session_sets("sessionExerciseId",position,repetitions) SELECT '00000000-0000-4000-8000-000000000004',i,i+1 FROM generate_series(0,500) i;`);
  await database.sql.unsafe(`INSERT INTO exercises(id,name) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Exercise '||lpad(i::text,3,'0') FROM generate_series(2,500) i;`);
  application = await ReadApplication.open(images, database.url);
  const template = await application.query("reference.template", { id: "00000000-0000-4000-8000-000000000002" }) as { entries: { targetRepetitions: number }[] };
  assert.equal(template.entries.length, 501); assert.equal(template.entries[500]!.targetRepetitions, 501);
  const session = await application.query("reference.session", { id: "00000000-0000-4000-8000-000000000003" }) as { exercises: { sets: { repetitions: number }[] }[] };
  assert.equal(session.exercises[0]!.sets.length, 501); assert.equal(session.exercises[0]!.sets[500]!.repetitions, 501);
  if (process.argv[3] === "--picker") {
    await database.sql.unsafe(`INSERT INTO workout_templates(id,name) SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'Template '||lpad(i::text,3,'0') FROM generate_series(5,14) i;
INSERT INTO workout_template_entries("templateId",position,"exerciseId","targetSets","targetRepetitions") SELECT id,0,'00000000-0000-4000-8000-000000000001',1,7 FROM workout_templates WHERE name LIKE 'Template %';`);
    server = serveReadApplication(application, await compileClient(await admitProject(root)));
    browser = await proofBrowser(new AbortController().signal);
    await usingProofContext(browser.browser, async context => {
      const page = await context.newPage(); await page.goto(server!.url.href);
      for (let catalogPage = 0; catalogPage < 5; catalogPage++) {
        await expect(page.getByRole("heading", { name: `Exercise ${String(2 + catalogPage * 100).padStart(3, "0")}`, exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2 })).toHaveCount(100);
        if (catalogPage < 4) await page.getByRole("link", { name: "Later exercises", exact: true }).click();
      }
      await expect(page.getByRole("heading", { name: "Exercise 500", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Later exercises", exact: true })).toHaveCount(0);
      await page.goto(new URL("/sessions", server!.url).href);
      const form = page.getByRole("form", { name: "New session", exact: true });
      await form.getByRole("button", { name: "Next templates", exact: true }).click({ timeout: 5000 });
      await expect(form.getByRole("combobox").first().locator("option")).toContainText(["Choose template", "Template 014"]);
      await form.getByRole("combobox").first().selectOption({ label: "Template 014" });
      await form.getByRole("button", { name: "Use template", exact: true }).click();
      await expect(form.getByText("Source template: Template 014", { exact: true })).toBeVisible();
      await expect(form.getByLabel("Repetitions", { exact: true })).toHaveValue("7");
    });
  }
  console.info(JSON.stringify({ ok: true, checks: ["501 ordered template entries", "501 ordered session sets", ...(process.argv[3] === "--picker" ? ["500 exercises browsable in five bounded pages", "eleventh template selectable and copied through browser UI"] : [])] }));
} catch (error) { failure = error; }
finally {
  for (const cleanup of [() => browser?.close(), () => server?.stop(true), () => application?.close(), () => database?.cleanup(), () => images?.dispose(), () => rm(root, { recursive: true, force: true })]) try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
}
if (failure || cleanupFailures.length) throw new AggregateError([failure, ...cleanupFailures].filter(Boolean), "Aggregate regression or cleanup failed");
