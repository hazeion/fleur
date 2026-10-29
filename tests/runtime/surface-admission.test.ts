import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";
import { compileClient } from "../../src/runtime/build/client";
import { compileWorker } from "../../src/runtime/build/worker";

async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fleur-surface-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("local aliases resolve before admission and both compilers use the admitted graph", async () => {
  await fixture({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["./shared/*"], "@client/*": ["./client/*"] } } }),
    "shared/label.ts": 'export const label = "admitted-alias-label";',
    "client/nested.ts": 'export { label } from "@shared/label";',
    "client/view.ts": 'export { label } from "@client/nested";',
    "server/private.ts": 'export const secret = "server-alias-canary";',
  }, async root => {
    const admitted = await admitProject(root);
    await writeFile(join(root, "shared/label.ts"), 'export const label = "changed-after-admission";');
    const worker = await compileWorker(admitted);
    const browser = await compileClient(admitted);
    const chunks = [...browser.files.values()].map(file => String(file.body)).join("\n");
    expect(worker).toContain("admitted-alias-label");
    expect(chunks).toContain("admitted-alias-label");
    expect(chunks).not.toContain("changed-after-admission");
    expect(chunks).not.toContain("server-alias-canary");
  });
});

test("source refusal identifies the safe location and remedy without echoing source or machine paths", async () => {
  await fixture({ "client/view.ts": 'const token = "source-secret-canary";\nexport const run = () => fetch("/__fleur/view?token=" + token);' }, async root => {
    const failure = await admitProject(root).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: "SOURCE_REJECTED", diagnostic: { file: "client/view.ts", line: 2, code: "MANUAL_TRANSPORT", action: expect.stringContaining("Fleur") } });
    expect(JSON.stringify(failure)).not.toContain("source-secret-canary");
    expect(JSON.stringify(failure)).not.toContain(root);
  });
});

test("browser source rejects named transport and executable aliases before either build", async () => {
  for (const source of [
    'export const run = globalThis["fe" + "tch"];',
    'export const run = globalThis[`fetch`];',
    'const key = "fetch"; export const run = globalThis[key];',
    'const ambient = {browser: globalThis}; export const run = ambient.browser.fetch;',
    'export const run = Reflect.get(globalThis, "fetch");',
    'const { sendBeacon: send } = navigator; export {send};',
    'export const run = new XMLHttpRequest();',
    'export const run = new WebSocket("wss://example.invalid");',
    'export const run = navigator.serviceWorker.register("/assets/worker.js");',
    'export const run = globalThis["eval"];',
    'export const run = (0, eval)("1");',
    'export const run = (() => {}).constructor("return 1");',
    'const F = Function; export const run = F("return 1");',
    'export const run = new globalThis.Worker("/assets/worker.js");',
    'export const run = import("data:text/javascript,export default 1");',
    'const name = "./view"; export const run = import(name);',
  ]) await fixture({ "client/view.ts": source }, async root => {
    await expect(admitProject(root), source).rejects.toThrow("SOURCE_REJECTED");
  });
});

test("executable TypeScript wrappers and ambient member paths retain source capability checks", async () => {
  for (const source of [
    'export const run = () => <unknown>fetch("/__fleur/view");',
    'export const run = () => <unknown>eval("42");',
    'export class Handler { constructor(readonly value = fetch("/__fleur/view")) {} }',
    'export enum Values { remote = fetch("/__fleur/view") as unknown as number }',
    'export namespace Values { export const remote = fetch("/__fleur/view"); }',
    'export const run = () => document.defaultView!.fetch("/__fleur/view");',
    'export const run = () => window[["fe", "tch"].join("") as "fetch"]("/__fleur/view");',
  ]) await fixture({ "client/view.ts": source }, async root => {
    await expect(admitProject(root), source).rejects.toThrow("SOURCE_REJECTED");
  });
});

test("source admission rejects authored styling and HTML injection while retaining inline JSX styles", async () => {
  await fixture({ "client/view.tsx": 'export const view = (size: number) => <div class="px-4 hover:opacity-50 w-[31px]" style={{ width: size, "--accent": "red" }}>Allowed</div>;' }, async root => {
    expect((await admitProject(root)).client).toHaveLength(1);
  });
  for (const source of [
    'export const view = <style>{"@theme { --color-brand: red; }"}</style>;',
    'export const view = <link rel="stylesheet" href="https://example.invalid/theme.css"/>;',
    'import {h as make} from "preact"; export const view = make("style", null, "p{color:red}");',
    'export const view = <div dangerouslySetInnerHTML={{__html: "<style>p{color:red}</style>"}}/>;',
    'export const change = (element: HTMLElement) => { element.innerHTML = "<style>p{color:red}</style>"; };',
    'export const sheet = new CSSStyleSheet();',
    'export const view = <svg><foreignObject><iframe/></foreignObject></svg>;',
    'export const view = <img src="javascript:alert(1)"/>;',
  ]) await fixture({ "client/view.tsx": source }, async root => {
    await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
  });
});

test("the CLI returns actionable source diagnostics as finite JSON before native execution", async () => {
  await fixture({
    "fleur.json": JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }),
    "client/view.ts": 'export const result = fetch("/__fleur/view?private=source-secret-canary");',
  }, async root => {
    const child = Bun.spawn([process.execPath, "bin/fleur.ts", "db", "migration", "generate", "--project", root, "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(1);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stdout).not.toContain("source-secret-canary");
    expect(stdout).not.toContain(root);
    expect(JSON.parse(stdout)).toMatchObject({ formatVersion: 1, ok: false, error: { code: "SOURCE_REJECTED", actual: { file: "client/view.ts", line: 1, code: "MANUAL_TRANSPORT" }, actions: [{ description: expect.stringContaining("Fleur") }] } });
  });
});

test("server source uses Fleur capabilities rather than ambient network or subprocess globals", async () => {
  for (const source of [
    'export const run = () => fetch("https://example.invalid");',
    'export const run = () => Bun.spawn(["echo", "unsafe"]);',
    'export const run = () => process.getBuiltinModule("child_process").execSync("echo unsafe");',
  ]) await fixture({ "server/operation.ts": source }, async root => {
    await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
  });
});

test("source admission refuses dangling links instead of silently admitting an incomplete graph", async () => {
  await fixture({ "client/view.ts": "export const label = 'Safe';" }, async root => {
    await symlink("missing.ts", join(root, "client/hidden.ts"));
    await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
  });
});

test("aliases, transitive imports, asset suffixes and package subpaths cannot cross graph authority", async () => {
  for (const imported of ["@server/private", "../shared/bridge", "fleur/server", "preact/compat", "fleur/client?raw", "../assets/icon.svg?url", "https://example.invalid/module.js", "blob:module", "data:text/javascript,export default 1"]) {
    await fixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@server/*": ["./server/*"] } } }),
      "server/private.ts": 'export const secret = "private-source-canary";',
      "shared/bridge.ts": imported === "../shared/bridge" ? 'export {secret} from "@server/private";' : "export const safe = true;",
      "assets/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
      "client/view.ts": `import * as imported from ${JSON.stringify(imported)}; export { imported };`,
    }, async root => { await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED"); });
  }
});

test("compiler refusals do not expose resolver paths or source text", async () => {
  await fixture({ "client/view.tsx": '/** @jsxImportSource source-secret-canary */\nexport const view = <div/>;' }, async root => {
    const project = await admitProject(root);
    for (const compile of [compileClient, compileWorker]) {
      const failure = await compile(project).then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({ message: "SOURCE_REJECTED", diagnostic: { code: "BUILD_REFUSED" } });
      expect(JSON.stringify(failure)).not.toContain("source-secret-canary");
      expect(JSON.stringify(failure)).not.toContain(root);
    }
  });
});

test("ordinary data fields, type members and locally bound helpers do not grant ambient capabilities", async () => {
  await fixture({ "client/view.ts": `
    interface Row { fetch: string; process: string; constructor: string; innerHTML: string; }
    const data: Row = {fetch:"Download", process:"Step", constructor:"Name", innerHTML:"Text"};
    export const fields = [data.fetch, data.process, data.constructor, data.innerHTML];
    export function process(value: number) { return value + 1; }
    export const result = process(2);
    export const render = (fetch: (value: string) => string) => fetch("local helper");
  ` }, async root => {
    const project = await admitProject(root);
    expect(project.client).toHaveLength(1);
    expect((await compileClient(project)).entry).toMatch(/^\/assets\//);
  });
});

test("unregistered import.meta asset paths are refused before Vite can read server files", async () => {
  await fixture({
    "server/private.ts": 'export const secret = "unadmitted-server-bytes";',
    "client/view.ts": 'export const leaked = new URL("../server/private.ts", import.meta.url).href;',
  }, async root => { await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED"); });
});
