import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileClient } from "../../src/runtime/build/client";
import { ReactiveProject } from "../../src/runtime/reactive-project";
import type { RefreshRequest } from "../../src/runtime/reactive-project";

test("two browser views discard obsolete responses, recover missed wakeups and history restoration, and reconcile epochs", async () => {
  const bundle = await compileClient(await admitProject(fileURLToPath(new URL("fixtures/exercises", import.meta.url))));
  let value = "Initial", revision = "0", epoch = "00000000-0000-4000-8000-000000000000", obsolete = false;
  const project = new ReactiveProject({
    revision: async () => ({ epoch, revision }), validate: (_name, input) => input, query: async () => value,
    render: async (_path, read) => {
      const name = String(await read("value", {}));
      return { html: `<template data-fleur-region="root"></template><table><tbody><tr><td><span id="stored">${name}</span><div data-fleur-island="island-0" data-fleur-identity="counter"><button>${name}: 0</button></div></td></tr></tbody></table><template data-fleur-end="root"></template>`, islands: [{ key: "island-0", id: "client/Counter.tsx#Counter", props: { name } }], regions: [{ id: "root", dependencies: [{ name: "value", input: {} }] }] };
    },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), asset = bundle.files.get(url.pathname);
    if (asset) return new Response(typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer, { headers: { "Content-Type": asset.type } });
    if (url.pathname === "/__fleur/view") {
      const command = await request.json() as RefreshRequest & { action: string; path: string };
      if (command.action === "dispose") { await project.dispose(command.connection, command.page); return Response.json({ disposed: true }); }
      try {
        const result = command.action === "open" ? await project.open(command.path) : await project.refresh(command);
        if (obsolete && command.action === "refresh") {
          obsolete = false;
          return Response.json({ ...result, sequence: result.sequence - 1, rendered: { ...result.rendered, html: result.rendered.html.replaceAll(value, "OBSOLETE") } });
        }
        return Response.json(result);
      } catch (error) { return Response.json({ error: { code: error instanceof Error ? error.message : "INTERNAL_FAILURE" } }, { status: 503 }); }
    }
    const initial = await project.open("/");
    const identity = { connection: initial.connection, page: initial.page, generation: 0, sequence: 0, epoch: initial.epoch, revision: initial.revision, status: initial.status };
    return new Response(`<!doctype html><html><body><div id="fleur-page">${initial.rendered.html}</div><script id="fleur-islands" type="application/json">${JSON.stringify(initial.rendered.islands)}</script><script id="fleur-view" type="application/json">${JSON.stringify(identity)}</script><script type="module" src="${bundle.entry}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    for (let repeat = 1; repeat <= 2; repeat++) {
      const first = await browser.newPage(), second = await browser.newPage();
      const errors: string[] = [];
      second.on("pageerror", error => errors.push(error.message));
      await first.goto(server.url.href); await second.goto(server.url.href);
      await second.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      await second.getByRole("button").click();
      value = `Committed ${repeat}`; revision = String(Number(revision) + 1);
      // No NOTIFY is supplied. Both independently connected views must probe.
      await browserExpect(first.locator("#stored")).toHaveText(value);
      await browserExpect(second.locator("#stored")).toHaveText(value);
      await browserExpect(second.getByRole("button")).toHaveText(`${value}: 1`);
      expect(await second.locator("table tr").count()).toBe(1);
      obsolete = true;
      value = `After obsolete ${repeat}`; revision = String(Number(revision) + 1);
      await browserExpect(second.locator("#stored")).toHaveText(value);
      expect(await second.locator("body").textContent()).not.toContain("OBSOLETE");
      await second.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
      value = `After history ${repeat}`; revision = String(Number(revision) + 1);
      await browserExpect(second.locator("#stored")).toHaveText(value);
      await browserExpect(second.getByRole("button")).toHaveText(`${value}: 1`);
      epoch = repeat === 1 ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002";
      revision = "0"; value = `Restored ${repeat}`;
      await browserExpect(first.locator("#stored")).toHaveText(value);
      await browserExpect(second.locator("#stored")).toHaveText(value);
      expect(errors).toEqual([]);
      await first.close(); await second.close();
    }
  } finally { await browser.close(); await server.stop(true); await project.close(); }
}, 45_000);
