import { expect, test } from "@playwright/test";

test("server HTML precedes browser effects and rejects invalid public props", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("Server exercise");
  expect(html).toContain('data-effects="0"');
  expect(html).not.toContain("FLEUR_SERVER_SECRET_CANARY_23");
  expect((await request.get("/?invalid=1")).status()).toBe(422);
});

test("server-region refresh preserves the island draft, focus, and effect identity", async ({ page }) => {
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Exercise draft" });
  await expect(page.getByLabel("Client effects")).toHaveText("1");
  await draft.fill("Unsubmitted draft");
  await draft.focus();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-refresh")));
  await expect(page.getByLabel("Saved server name")).toHaveText("Updated exercise");
  await expect(page.getByLabel("Island saved name")).toHaveText("Updated exercise");
  await expect(draft).toHaveValue("Unsubmitted draft");
  await expect(draft).toBeFocused();
  await expect(page.getByLabel("Client effects")).toHaveText("1");
});

test("invalid initial or refreshed island props never reach the component", async ({ page }) => {
  await page.goto("/?invalid-hydration=1");
  await expect(page.getByRole("status", { name: "Fixture state" })).toHaveText("Rejected initial props");
  await expect(page.getByLabel("Client effects")).toHaveText("0");
  await page.goto("/");
  const draft = page.getByRole("textbox", { name: "Exercise draft" });
  await expect(page.getByLabel("Client effects")).toHaveText("1");
  await draft.fill("Kept after rejection");
  await draft.focus();
  await page.evaluate(() => window.dispatchEvent(new Event("fixture-invalid-refresh")));
  await expect(page.getByRole("status", { name: "Fixture state" })).toHaveText("Rejected refresh props");
  await expect(page.getByLabel("Saved server name")).toHaveText("Server exercise");
  await expect(draft).toHaveValue("Kept after rejection");
  await expect(draft).toBeFocused();
});
