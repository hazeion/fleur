import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";
import { compileWorker } from "../../src/runtime/build/worker";
import { compileClient } from "../../src/runtime/build/client";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { startWorker } from "../../src/runtime/native/host";
import { serveReadApplication } from "../../src/runtime/http";
import type { ReadApplication } from "../../src/runtime/application";
import type { PageResult } from "../../src/runtime/worker-execution";

test("statically named lazy islands register before execution and nested private props never reach the browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-lazy-surface-"));
  let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof serveReadApplication> | undefined;
  try {
    for (const name of ["server", "client"]) await mkdir(join(root, name));
    await writeFile(join(root, "client/Tile.tsx"), `
      import {defineIsland} from "fleur/client";
      import {schema} from "fleur/schema";
      import {useState} from "preact/hooks";
      export const Tile = defineIsland({props:schema.object({profile:schema.object({name:schema.string()})}),component:({profile})=>{
        const [count,setCount]=useState(0);
        return <button onClick={()=>setCount(count+1)}>{profile.name}: {count}</button>;
      }});
    `);
    await writeFile(join(root, "server/page.tsx"), `
      import {definePage} from "fleur/routing";
      import {registerPage} from "fleur/server";
      import {schema} from "fleur/schema";
      export const good = definePage({path:"/good",params:schema.object({})});
      export const bad = definePage({path:"/bad",params:schema.object({})});
      registerPage(good,{component:async()=>{const {Tile}=await import("../client/Tile");return <Tile profile={{name:"Basil"}}/>;}});
      registerPage(bad,{component:async()=>{const {Tile}=await import("../client/Tile");return <Tile profile={{name:"Basil",secret:"nested-server-secret-canary"}}/>;}});
    `);
    const admitted = await admitProject(root);
    const bundle = await compileClient(admitted);
    expect([...bundle.files.values()].map(file => String(file.body)).join("\n")).not.toContain("nested-server-secret-canary");
    images = await prepareNativeImages(await compileWorker(admitted));
    const run = async (mode: string, path?: string) => {
      const worker = await startWorker(images!);
      const session = crypto.randomUUID();
      try {
        return await worker.run({ mode, session, ...(path ? { path } : {}) }, request => {
          const message = request as { kind: string; sequence: number };
          expect(message.kind).toBe("registry");
          return { session, sequence: message.sequence, value: null };
        }) as { kind: string; value: PageResult & { islands: { id: string }[] }; code?: string };
      } finally { await worker.close(); }
    };
    const registered = await run("register");
    expect(registered.kind).toBe("complete");
    expect(registered.value.islands.map(island => island.id)).toEqual(["client/Tile.tsx#Tile"]);
    const rendered = await run("render", "/good");
    expect(rendered.kind).toBe("complete");
    expect(rendered.value.html).toContain("Basil: 0");
    expect(rendered.value.islands).toMatchObject([{ id: "client/Tile.tsx#Tile", props: { profile: { name: "Basil" } } }]);
    const refused = await run("render", "/bad");
    expect(refused.kind).toBe("failure");
    expect(JSON.stringify(refused)).not.toContain("nested-server-secret-canary");
    const app = {
      prepareWorkers() {}, registry: { queries: new Map() },
      async revision() { return { epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }; },
      async watch() { return async () => {}; },
      async render() { return rendered.value; },
    } as unknown as ReadApplication;
    server = serveReadApplication(app, bundle);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(server.url.origin + "/good");
    await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
    await page.getByRole("button", { name: "Basil: 0" }).click();
    await browserExpect(page.getByRole("button", { name: "Basil: 1" })).toBeVisible();
  } finally {
    await browser?.close(); await server?.stop(true); await images?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
