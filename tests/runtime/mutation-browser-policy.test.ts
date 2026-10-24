import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileClient } from "../../src/runtime/build/client";
import { serveReadApplication } from "../../src/runtime/http";
import type { ReadApplication } from "../../src/runtime/application";

test("production browser entry denies fresh realms and alternate browser data transports", async () => {
  const bundle = await compileClient(await admitProject(fileURLToPath(new URL("fixtures/saves", import.meta.url))));
  const app = { async render() { return { html: "<main>Browser policy</main>", islands: [] }; } } as unknown as ReadApplication;
  const server = serveReadApplication(app, bundle);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.origin);
    await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
    const results = await page.evaluate(() => {
      const probe = (run: () => unknown) => { try { run(); return "allowed"; } catch { return "denied"; } };
      return [
        probe(() => window.fetch("/__fleur/mutation")),
        probe(() => Reflect.apply(Navigator.prototype.sendBeacon, navigator, ["/__fleur/mutation", "test"])),
        probe(() => { const popup = window.open("about:blank"); if (!popup) throw new Error("Blocked"); popup.close(); }),
        probe(() => { const frame = document.createElement("iframe"); document.body.append(frame); void frame.contentWindow!.fetch; }),
        probe(() => { const container = document.createElement("div"); container.innerHTML = "<iframe></iframe>"; document.body.append(container); }),
        probe(() => { document.execCommand("insertHTML", false, "<iframe></iframe>"); }),
        probe(() => { const doc = document.implementation.createDocument("http://www.w3.org/1999/xhtml", "iframe"); document.body.append(doc.documentElement); }),
      ];
    });
    expect(results).toEqual(Array(7).fill("denied"));
    const dangerous = serveReadApplication({ async render() { return { html: '<iframe src="about:blank"></iframe>', islands: [] }; } } as unknown as ReadApplication, bundle);
    try { expect((await fetch(dangerous.url.origin)).status).toBe(500); }
    finally { await dangerous.stop(true); }
  } finally { await browser.close(); await server.stop(true); }
}, 30_000);
