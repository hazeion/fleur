import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { h, type ComponentType } from "preact";
import { schema } from "../../src/schema";
import { definePage } from "../../src/routing";
import { registerPage } from "../../src/server";
import { executePage, nameExports } from "../../src/runtime/worker-execution";
import { pages, pageNames } from "../../src/runtime/registrations";
import { islandNames } from "../../src/runtime/islands";

const sourcePath = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));

test("nested islands preserve server DOM and mount their child effects once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fleur-nested-island-review-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let fixture: { Parent: ComponentType<Record<string, never>>; Child: ComponentType<Record<string, never>> } | undefined;
  const route = definePage({ path: "/review-nested", params: schema.object({}) });
  try {
    const fixturePath = join(directory, "islands.ts");
    await writeFile(fixturePath, `
import { h } from ${sourcePath("../../node_modules/preact/dist/preact.mjs")};
import { useEffect, useState } from ${sourcePath("../../node_modules/preact/hooks/dist/hooks.mjs")};
import { schema } from ${sourcePath("../../src/schema.ts")};
import { defineIsland } from ${sourcePath("../../src/client.ts")};
export const Child = defineIsland({ props: schema.object({}), component: () => {
  const [count, setCount] = useState(0);
  useEffect(() => { globalThis.reviewChildMounts = (globalThis.reviewChildMounts || 0) + 1; }, []);
  return h("button", { onClick: () => setCount(count + 1) }, "Child: " + count);
} });
export const Parent = defineIsland({ props: schema.object({}), component: () => h("section", null, h(Child, {})) });
`);
    fixture = await import(fixturePath) as typeof fixture;
    if (!fixture) throw new Error("Missing fixture");
    registerPage(route, { component: () => h(fixture!.Parent, {}) });
    nameExports({ Parent: fixture.Parent, Child: fixture.Child, route });
    const rendered = await executePage("/review-nested", async () => null);
    const entry = join(directory, "entry.ts");
    await writeFile(entry, `import { Parent, Child } from ${JSON.stringify(fixturePath)}; import { hydrateAdmitted } from ${sourcePath("../../src/runtime/hydration.ts")}; hydrateAdmitted({ Parent, Child });`);
    const build = await Bun.build({ entrypoints: [entry], target: "browser" });
    expect(build.success).toBe(true);
    const javascript = await build.outputs[0]!.text();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/client.js") return new Response(javascript, { headers: { "Content-Type": "text/javascript" } });
      return new Response(`<!doctype html><html><body><h1>Server content</h1>${rendered.html}<script id="fleur-islands" type="application/json">${JSON.stringify(rendered.islands)}</script><script>globalThis.reviewOriginalButton = document.querySelector("button");</script><script type="module" src="/client.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
    for (let repeat = 0; repeat < 2; repeat++) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(server.url.href);
      await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      await browserExpect.poll(() => page.evaluate("globalThis.reviewChildMounts")).toBeGreaterThan(0);
      const observation = await page.evaluate("({ mounts: globalThis.reviewChildMounts, originalButtonPreserved: globalThis.reviewOriginalButton === document.querySelector('button') })");
      expect(observation).toEqual({ mounts: 1, originalButtonPreserved: true });
      await browserExpect(page.getByRole("heading", { name: "Server content" })).toBeVisible();
      await page.getByRole("button", { name: "Child: 0" }).click();
      await browserExpect(page.getByRole("button", { name: "Child: 1" })).toBeVisible();
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser?.close(); await server?.stop(true);
    pages.delete(route); pageNames.delete(route);
    if (fixture) { islandNames.delete(fixture.Parent); islandNames.delete(fixture.Child); }
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
