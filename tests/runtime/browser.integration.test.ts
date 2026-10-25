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

test("direct browser navigation preserves server HTML and hydrates only validated islands", async () => {
  const project = await admitProject(fileURLToPath(new URL("fixtures/exercises", import.meta.url)));
  const bundle = await compileClient(project);
  const source = [...bundle.files.values()].map(file => typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body)).join("\n");
  expect(source).not.toContain("server-only-implementation-canary");
  expect(source).not.toContain("server/exercises");
  expect(source).not.toContain("FLEUR_PRIVATE_DATABASE_URL");
  expect(source).not.toContain("database/broker");
  expect(source).toContain("Counter.tsx");
  const images = await prepareNativeImages(await compileWorker(project));
  const fixture = await ownedPostgres().catch(async error => { await images.dispose(); throw error; });
  let app: ReadApplication | undefined;
  let server: ReturnType<typeof serveReadApplication> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await fixture.sql.unsafe("CREATE TABLE exercises (id uuid PRIMARY KEY, name text NOT NULL, note text, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO exercises (id,name) VALUES ('00000000-0000-4000-8000-000000000001','Squat')");
    await fixture.reviewApplication(images);
    app = await ReadApplication.open(images, fixture.url);
    server = serveReadApplication(app, bundle);
    const address = server.url.origin;
    const initial = await fetch(address+"/exercises");
    const html = await initial.text();
    expect(html).toContain("<h1>Exercises</h1>");
    expect(html).toContain("Squat: 0");
    expect(html).not.toContain(fixture.url);
    browser = await chromium.launch({ headless: true });
    for (let repeat = 0; repeat < 2; repeat++) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(address+"/exercises");
      await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      await browserExpect(page.getByRole("heading", { name: "Exercises" })).toBeVisible();
      await page.getByRole("button", { name: "Squat: 0" }).click();
      await browserExpect(page.getByRole("button", { name: "Squat: 1" })).toBeVisible();
      await page.getByRole("link", { name: "Squat", exact: true }).click();
      await browserExpect(page.getByRole("heading", { name: "Squat", exact: true })).toBeVisible();
      await page.reload();
      await browserExpect(page.getByRole("heading", { name: "Squat", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
      await page.close();
    }
    const invalid = await fetch(address+"/exercises/not-a-uuid");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: "ROUTE_INVALID" } });
    const rejected = await browser.newPage();
    const errors: string[] = [];
    rejected.on("pageerror", error => errors.push(error.message));
    await rejected.route(address+"/exercises", route => route.fulfill({ status: 200, contentType: "text/html", body: html.replace('"props":{"name":"Squat"}', '"props":{"name":"Squat","secret":"undeclared"}') }));
    await rejected.goto(address+"/exercises");
    await browserExpect.poll(() => errors.length).toBeGreaterThan(0);
    expect(await rejected.locator("html").getAttribute("data-fleur-hydrated")).toBeNull();
    await rejected.getByRole("button", { name: "Squat: 0" }).click();
    await browserExpect(rejected.getByRole("button", { name: "Squat: 0" })).toBeVisible();
    await rejected.close();
  } finally { await browser?.close(); await server?.stop(true); await app?.close(); await fixture.cleanup(); await images.dispose(); }
}, 300_000);
