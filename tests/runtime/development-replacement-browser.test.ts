import { expect, test } from "bun:test";
import { chromium, expect as browserExpect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";
import { browserVersionHeaders, refuseStaleBrowser } from "../../src/runtime/development/browser-version";
import { compileClient } from "../../src/runtime/build/client";
import { ReactiveProject, type RefreshRequest } from "../../src/runtime/reactive-project";

// Browser transport/component evidence only. No database or public dev gate is substituted.
for (const layout of ["compatible", "compatible-shared", "uncertain-style", "incompatible", "uncertain", "dependent-state", "ref-assignment", "ref-alias", "state-control", "state-control-alias", "state-getter", "callback-parameter", "tagged-helper", "opaque-callback", "escaped-writer", "escaped-hook-callback", "ambiguous-query"] as const) test(`source replacement retains draft, focus and nested hooks; layout ${layout}`, async () => {
  const incompatible = layout !== "compatible" && layout !== "compatible-shared";
  const root = await mkdtemp(join(await realpath(tmpdir()), "fleur-browser-replacement-"));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const projects: ReactiveProject[] = [];
  try {
    await mkdir(join(root, "client"));
    let source = 'import { defineIsland, useQuery, useMutation } from "fleur/client"; import { schema, defineQuery, defineMutation } from "fleur/schema"; import { useState, useEffect, useRef } from "preact/hooks"; export const Child = defineIsland({ props: schema.object({}), component: () => { const [count,setCount] = useState(0); return <button onClick={() => setCount(value => value+1)}>Child {count}</button>; } }); export const touch = defineMutation({ name: "catalog.touch", input: schema.object({}), output: schema.object({}) }); export const summary = defineQuery({ name: "catalog.summary", input: schema.object({}), output: schema.string() }); export const Editor = defineIsland({ props: schema.object({ name: schema.string() }), component: ({name}) => { const query = useQuery(summary, {}); const mutation = useMutation(touch); const [draft,setDraft] = useState(name), [clicks,setClicks] = useState(0), [mounts,setMounts] = useState(0); useEffect(() => {setMounts(value => value+1);}, []); return <section><Child key="nested"/><label>Draft<input value={draft} onInput={event => setDraft(event.currentTarget.value)}/></label><button onClick={() => setClicks(value => value+1)}>Clicks {clicks}</button><p>Mounts {mounts}</p><button onClick={() => mutation.run({})}>Submit</button><p aria-label="Mutation">{mutation.status} {mutation.error?.code ?? ""}</p><p aria-label="Summary">{query.status === "success" ? query.data : query.status}</p></section>; } });';
    if (layout === "uncertain") source = source.replace("export const Editor =", "const useEditorDraft = (value: string) => useState(value); export const Editor =").replace("useState(name)", "useEditorDraft(name)");
    if (layout === "dependent-state") source = source.replace("useState(name)", "useState<unknown>(query.data ?? name)").replace("value={draft}", 'value={typeof draft === "string" ? draft : JSON.stringify(draft)}');
    if (layout === "ref-assignment" || layout === "ref-alias") {
      const capture = layout === "ref-assignment" ? 'if (query.status === "success" && snapshot.current === null) snapshot.current = query.data;' : 'const holder = snapshot; const {data: queryValue, status: queryStatus} = query; if (queryStatus === "success" && holder.current === null) { const storedQueryValue = queryValue; holder.current = storedQueryValue; }';
      source = source.replace('return <section><Child', `const snapshot = useRef<unknown>(null); ${capture} return <section><p aria-label="Snapshot">{typeof snapshot.current === "string" ? snapshot.current : "Empty"}</p><Child`);
    }
    if (layout === "state-control") source = source.replace('return <section><Child', 'const [snapshot,setSnapshot] = useState("Empty"); const {status, data} = query; if (status === "success" && snapshot === "Empty") setSnapshot(data); return <section><p aria-label="Snapshot">{snapshot}</p><Child');
    if (layout === "state-control-alias") source = source.replace('return <section><Child', 'const [snapshot,setSnapshot] = useState<unknown>(null); const storeSnapshot = setSnapshot; const querySuccessful = query.status === "success"; if (querySuccessful && snapshot === null) storeSnapshot("cached"); return <section><p aria-label="Snapshot">{typeof snapshot === "string" ? snapshot : "Empty"}</p><Child');
    if (layout === "state-getter") source = source.replace('return <section><Child', 'const [snapshot,setSnapshot] = useState<unknown>(null); function currentData() { return query.data; } if (snapshot === null && currentData() !== undefined) setSnapshot(currentData()); return <section><p aria-label="Snapshot">{typeof snapshot === "string" ? snapshot : "Empty"}</p><Child');
    if (layout === "callback-parameter" || layout === "tagged-helper") {
      const capture = layout === "callback-parameter" ? '[query.data].forEach(capturedItem => { if (capturedItem !== undefined) setSnapshot(previous => previous ?? capturedItem); });' : 'function store(_parts: TemplateStringsArray, capturedItem: unknown) { setSnapshot(capturedItem); } if (query.status === "success" && snapshot === null) store`${query.data}`;';
      source = source.replace('return <section><Child', `const [snapshot,setSnapshot] = useState<unknown>(null); ${capture} return <section><p aria-label="Snapshot">{typeof snapshot === "string" ? snapshot : "Empty"}</p><Child`);
    }
    if (layout === "opaque-callback" || layout === "escaped-writer") {
      const capture = layout === "opaque-callback" ? '[query.data].forEach(capturedItem => { if (capturedItem !== undefined) setSnapshot(previous => previous ?? capturedItem); });' : '[query.data].forEach(setSnapshot);';
      source = source.replace('return <section><Child', `const [snapshot,setSnapshot] = useState<unknown>(null); ${capture} return <section><p aria-label="Snapshot">{snapshot == null ? "Empty" : typeof snapshot === "string" ? snapshot : (snapshot as {title:string}).title}</p><Child`);
    }
    if (layout === "escaped-hook-callback") source = source.replace('export const Editor =', 'const createInitial = () => 0; export const Editor =').replace('return <section><Child', 'const [opaque,setOpaque] = useState(createInitial); return <section><Child');
    if (layout === "ambiguous-query") source = source.replace('export const Editor =', 'const privateSummary = defineQuery({ name: "catalog.summary", input: schema.object({}), output: schema.string() }); export const Editor =');
    const shared = 'import {schema,defineQuery} from "fleur/schema"; export const summary = defineQuery({ name: "catalog.summary", input: schema.object({}), output: schema.string() });';
    if (layout === "compatible-shared") {
      await mkdir(join(root, "shared")); await writeFile(join(root, "shared/catalog.ts"), shared);
      source = source.replace('export const summary = defineQuery({ name: "catalog.summary", input: schema.object({}), output: schema.string() });', 'import {summary} from "../shared/catalog"; export {summary};');
    }
    await writeFile(join(root, "client/Editor.tsx"), source);
    const first = await compileClient(await admitProject(root));
    let replacement = source;
    if (layout === "uncertain-style") replacement = replacement.replace('Draft<input value', 'Draft<input class="hidden" value');
    if (layout === "incompatible") replacement = replacement.replace("const [draft,setDraft]", 'const [introduced] = useState("Introduced"); const [draft,setDraft]').replace("return <section>", "return <section><p>{introduced}</p>");
    if (layout === "ref-assignment" || layout === "ref-alias") replacement = replacement.replace('typeof snapshot.current === "string" ? snapshot.current : "Empty"', '(snapshot.current as {title: string} | null)?.title.toUpperCase() ?? "Empty"');
    if (layout === "state-control") replacement = replacement.replace('useState("Empty")', 'useState<unknown>("Empty")').replace('{snapshot}</p>', '{typeof snapshot === "object" && snapshot ? (snapshot as {title:string}).title.toUpperCase() : "Empty"}</p>');
    if (layout === "state-control-alias") replacement = replacement.replace('storeSnapshot("cached")', 'storeSnapshot({title:"cached"})').replace('typeof snapshot === "string" ? snapshot : "Empty"', 'typeof snapshot === "object" && snapshot ? (snapshot as {title:string}).title.toUpperCase() : "Empty"');
    if (layout === "state-getter") replacement = replacement.replace('typeof snapshot === "string" ? snapshot : "Empty"', 'typeof snapshot === "object" && snapshot ? (snapshot as {title:string}).title.toUpperCase() : "Empty"');
    if (layout === "escaped-writer") replacement = replacement.replace('snapshot == null ? "Empty" : typeof snapshot === "string" ? snapshot : (snapshot as {title:string}).title', 'snapshot == null ? "Empty" : (snapshot as {title:string}).title.length');
    if (layout === "callback-parameter" || layout === "tagged-helper") replacement = replacement.replace('typeof snapshot === "string" ? snapshot : "Empty"', 'snapshot === null ? "Empty" : (snapshot as {title:string}).title.length');
    await writeFile(join(root, "client/Editor.tsx"), replacement.replace("Clicks {clicks}", "Taps {clicks}").replaceAll("<button onClick", '<button class="italic" onClick').replace("output: schema.string()", "output: schema.object({ title: schema.string() })").replace("? query.data :", "? query.data.title.toUpperCase() :"));
    if (layout === "compatible-shared") await writeFile(join(root, "shared/catalog.ts"), shared.replace("output: schema.string()", "output: schema.object({ title: schema.string() })"));
    const second = await compileClient(await admitProject(root));
    if (["ref-assignment", "ref-alias", "state-control", "state-control-alias", "state-getter"].includes(layout)) expect(second.compatibility).not.toBe(first.compatibility);
    if (layout === "ambiguous-query") expect(second.compatibility).not.toBe(first.compatibility);
    const files = new Map([...first.files, ...second.files]);
    let generation = 1, opened = 0, documents = 0, submitted = 0;
    const makeProject = () => {
      const project = new ReactiveProject({ revision: async () => ({ epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }), validate: (_name, input) => input, query: async () => generation === 1 ? "Original summary" : { title: "Replacement summary" },
        render: async () => ({ html: `<h1>Generation ${generation}</h1><div data-fleur-island="island-0" data-fleur-identity="editor"><section>${["ref-assignment", "ref-alias", "state-control", "state-control-alias", "state-getter", "callback-parameter", "tagged-helper", "opaque-callback", "escaped-writer"].includes(layout) ? '<p aria-label="Snapshot">Empty</p>' : ""}<button>Child 0</button><label>Draft<input value="Stored"></label><button>${generation === 1 ? "Clicks" : "Taps"} 0</button><p>Mounts 0</p></section></div>`, islands: [{ key: "island-0", id: "client/Editor.tsx#Editor", props: { name: "Stored" } }], regions: [] }) });
      projects.push(project); return project;
    };
    let project = makeProject();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname, asset = files.get(path);
      if (asset) return new Response(typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer, { headers: { "Content-Type": asset.type } });
      const version = { marker: `owner:${generation}`, browser: generation === 1 ? first : second };
      const stale = refuseStaleBrowser(request, version); if (stale) return stale;
      if (path === "/__fleur/mutation") { submitted++; return Response.json({ status: "success", data: {} }); }
      const headers = browserVersionHeaders(version);
      if (path === "/__fleur/view") {
        const command = await request.json() as RefreshRequest & { action: string; path: string };
        try {
          if (command.action === "dispose") { await project.dispose(command.connection, command.page); return Response.json({ disposed: true }, { headers }); }
          if (command.action === "open") opened++;
          return Response.json(await (command.action === "open" ? project.open(command.path) : project.refresh(command)), { headers });
        } catch (error) { return Response.json({ error: { code: error instanceof Error ? error.message : "INTERNAL_FAILURE" } }, { status: 503, headers }); }
      }
      documents++;
      const view = await project.open("/");
      return new Response(`<!doctype html><html><head><meta name="fleur-client-compatibility" content="${(generation === 1 ? first : second).compatibility ?? ""}"><link rel="stylesheet" href="${(generation === 1 ? first : second).stylesheet}"><meta name="fleur-development" content="owner:${generation}"></head><body><div id="fleur-refresh-status" role="status"></div><div id="fleur-page">${view.rendered.html}</div><script type="application/json" id="fleur-islands">${JSON.stringify(view.rendered.islands)}</script><script type="application/json" id="fleur-view">${JSON.stringify({ connection: view.connection, page: view.page, generation: view.generation, sequence: view.sequence, epoch: view.epoch, revision: view.revision, status: view.status })}</script><script type="module" src="${(generation === 1 ? first : second).entry}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
    for (let repeat = 0; repeat < 2; repeat++) {
      generation = 1; project = makeProject();
      const page = await browser.newPage(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(server.url.href);
      await browserExpect(page.getByText("Mounts 1", { exact: true })).toBeVisible();
      await browserExpect(page.getByLabel("Summary")).toHaveText("Original summary");
      if (["ref-assignment", "ref-alias", "state-control", "state-getter", "callback-parameter", "tagged-helper", "opaque-callback", "escaped-writer"].includes(layout)) await browserExpect(page.getByLabel("Snapshot")).toHaveText("Original summary");
      if (layout === "state-control-alias") await browserExpect(page.getByLabel("Snapshot")).toHaveText("cached");
      if (incompatible) {
        await page.route("**/__fleur/mutation", async route => { await route.fetch(); await route.abort("failed"); });
        await page.getByRole("button", { name: "Submit", exact: true }).click();
        await browserExpect(page.getByLabel("Mutation")).toContainText("outcome-unknown");
        await page.unroute("**/__fleur/mutation");
      }
      const draft = page.getByRole("textbox", { name: "Draft" });
      await page.getByRole("button", { name: "Child 0" }).click();
      await page.getByRole("button", { name: "Child 1" }).click();
      await draft.fill("Unsaved draft"); await page.getByRole("button", { name: "Clicks 0" }).click(); await draft.focus();
      await page.evaluate(() => { (globalThis as unknown as { original: Element | null }).original = document.activeElement; });
      const before = documents, beforeOpen = opened, beforeSubmitted = submitted;
      generation = 2; await project.close(); project = makeProject();
      if (incompatible) {
        if (["callback-parameter", "tagged-helper", "opaque-callback", "escaped-writer"].includes(layout)) {
          await browserExpect.poll(async () => errors.length > 0 || (await page.getByRole("status").textContent())?.includes("Navigate or reload explicitly"), { timeout: 15000 }).toBe(true);
          await browserExpect(draft).toHaveValue("Unsaved draft");
          expect(errors).toEqual([]);
          expect(second.compatibility).not.toBe(first.compatibility);
        }
        await browserExpect(page.getByRole("status")).toContainText("Navigate or reload explicitly", { timeout: 15000 });
        if (["ref-assignment", "ref-alias", "state-control", "state-getter", "callback-parameter", "tagged-helper", "opaque-callback", "escaped-writer"].includes(layout)) await browserExpect(page.getByLabel("Snapshot")).toHaveText("Original summary");
        if (layout === "state-control-alias") await browserExpect(page.getByLabel("Snapshot")).toHaveText("cached");
        await browserExpect(draft).toHaveValue("Unsaved draft"); await browserExpect(draft).toBeFocused();
        await browserExpect(page.getByRole("button", { name: "Child 2" })).toBeVisible();
        await browserExpect(page.getByRole("button", { name: "Clicks 1" })).toBeVisible();
        expect(await page.evaluate(() => (globalThis as unknown as { original: Element }).original === document.activeElement)).toBe(true);
        expect(documents).toBe(before); expect(opened).toBe(beforeOpen);
        await browserExpect(page.getByLabel("Mutation")).toContainText("outcome-unknown");
        await page.getByRole("button", { name: "Submit", exact: true }).click();
        await browserExpect(page.getByLabel("Mutation")).toContainText("failure SOURCE_CHANGED");
        expect(submitted).toBe(beforeSubmitted);
        await page.reload();
        await browserExpect(page.getByRole("heading", { name: "Generation 2" })).toBeVisible();
        await browserExpect(page.getByRole("textbox", { name: "Draft", includeHidden: layout === "uncertain-style" })).toHaveValue("Stored");
        await browserExpect(page.getByRole("button", { name: "Taps 0" })).toBeVisible();
        if (["ref-assignment", "ref-alias", "state-control", "state-getter"].includes(layout)) await browserExpect(page.getByLabel("Snapshot")).toHaveText("REPLACEMENT SUMMARY");
        if (layout === "state-control-alias") await browserExpect(page.getByLabel("Snapshot")).toHaveText("CACHED");
        if (["callback-parameter", "tagged-helper", "escaped-writer"].includes(layout)) await browserExpect(page.getByLabel("Snapshot")).toHaveText("19");
        if (layout === "opaque-callback") await browserExpect(page.getByLabel("Snapshot")).toHaveText("Replacement summary");
        expect(submitted).toBe(beforeSubmitted); expect(errors).toEqual([]);
        await page.close(); continue;
      }
      await browserExpect(page.getByRole("heading", { name: "Generation 2" })).toBeVisible({ timeout: 15000 });
      await browserExpect(page.getByRole("button", { name: "Taps 1" })).toBeVisible();
      await browserExpect(page.getByRole("button", { name: "Taps 1" })).toHaveCSS("font-style", "italic");
      await browserExpect(page.getByLabel("Summary")).toHaveText("REPLACEMENT SUMMARY");
      await browserExpect(page.getByRole("button", { name: "Child 2" })).toBeVisible();
      await browserExpect(draft).toHaveValue("Unsaved draft"); await browserExpect(draft).toBeFocused();
      await browserExpect(page.getByText("Mounts 1", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => (globalThis as unknown as { original: Element }).original === document.activeElement)).toBe(true);
      expect(documents).toBe(before); expect(opened).toBe(beforeOpen+1); expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser?.close(); await server?.stop(true);
    for (const project of projects) await project.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
