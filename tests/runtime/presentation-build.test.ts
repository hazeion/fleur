import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitProject } from "../../src/runtime/build/admission";
import { compileClient } from "../../src/runtime/build/client";
import { chromium } from "@playwright/test";
import { serveReadApplication } from "../../src/runtime/http";
import type { ReadApplication } from "../../src/runtime/application";

test("client builds complete Tailwind utilities from admitted source without loading application CSS configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-presentation-"));
  try {
    await mkdir(join(root, "client"));
    const source = join(root, "client", "view.tsx");
    await writeFile(source, `export const View = ({ wide }: { wide: boolean }) => <div class={wide ? "w-[123px] hover:text-red-500" : "w-[47px]"} style={{ "--accent": wide ? "blue" : "red", color: "var(--accent)" }}>Styled</div>;`);
    // No application configuration or generated styles are executable inputs.
    await writeFile(join(root, "tailwind.config.js"), 'throw new Error("Application configuration executed");');
    const admitted = await admitProject(root);
    await writeFile(source, 'export const View = () => <div class="w-[999px]"/>;');
    const build = await compileClient(admitted);
    const css = [...build.files.values()].filter(file => file.type.startsWith("text/css")).map(file => String(file.body)).join("\n");
    expect(css).toMatch(/width:\s*123px/);
    expect(css).toMatch(/width:\s*47px/);
    expect(css).toContain("--color-red-500");
    expect(css).toContain(":hover");
    expect(css).not.toMatch(/width:\s*999px/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Tailwind follows server presentation classes without copying private strings or conditional inputs into CSS", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-private-styles-"));
  try {
    await mkdir(join(root, "server"));
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "server", "private.ts"), `export const privateNote = 'content-["server-only-review-canary"]';`);
    await writeFile(join(root, "shared", "classes.ts"), 'export const compact = "w-[47px]";');
    await writeFile(join(root, "server", "page.tsx"), `
      import { compact } from "../shared/classes";
      import { privateNote } from "./private";
      const roomy = "w-[123px] hover:text-red-500";
      const hidden = 'content-["unused-local-canary"]';
      export function Page() { const selected = privateNote ? roomy : compact; return <main className={selected}><p class="font-bold">Public</p></main>; }
    `);
    const bundle = await compileClient(await admitProject(root));
    const css = [...bundle.files.values()].filter(file => file.type.startsWith("text/css")).map(file => String(file.body)).join("\n");
    expect(css).not.toContain("server-only-review-canary");
    expect(css).not.toContain("unused-local-canary");
    expect(css).toMatch(/width:\s*123px/);
    expect(css).toMatch(/width:\s*47px/);
    expect(css).toContain(":hover");
    expect(css).toContain("font-weight:");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("presentation class tracing respects local shadows, named reexports, helper returns and spread props", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-class-selection-"));
  try {
    await mkdir(join(root, "server"));
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "shared", "classes.ts"), 'export const compact = "w-[53px]";');
    await writeFile(join(root, "shared", "index.ts"), 'export {compact as small} from "./classes";');
    await writeFile(join(root, "server", "page.tsx"), `
      import { h as element } from "preact";
      import * as P from "preact";
      import { small } from "../shared/index";
      const choice = 'content-["shadowed-private-canary"]';
      const props = { className: "h-[71px]", note: 'content-["unrendered-prop-canary"]' };
      const styles = { large: "w-[137px]", small };
      function select(value: string, hidden: string) { return hidden ? value : "w-[53px]"; }
      const sizes = (wide: boolean) => wide ? "h-[79px]" : "h-[83px]";
      export function Page({wide}: {wide:boolean}) {
        const choice = wide ? styles.large : styles.small;
        return <main {...props} class={select(choice, 'content-["predicate-private-canary"]')}><aside class={sizes(wide)}/>{element("p", {className: "font-semibold"}, "Public")}{P.h("p", {class: "p-[17px]"}, "Namespace")}</main>;
      }
    `);
    const bundle = await compileClient(await admitProject(root));
    const css = String(bundle.files.get(bundle.stylesheet!)!.body);
    expect(css).toMatch(/width:\s*137px/);
    expect(css).toMatch(/width:\s*53px/);
    expect(css).toMatch(/height:\s*71px/);
    expect(css).toContain("--font-weight-semibold");
    expect(css).toMatch(/height:\s*79px/);
    expect(css).toMatch(/height:\s*83px/);
    expect(css).toMatch(/padding:\s*17px/);
    for (const value of ["shadowed-private-canary", "unrendered-prop-canary", "predicate-private-canary"]) expect(css).not.toContain(value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("complete utility selection supports computed maps, arrays, assignments and imported or method helpers", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-complete-selection-"));
  try {
    await mkdir(join(root, "server"));
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "shared", "classes.ts"), `export function classes(...values: string[]) { return values.join(" "); }`);
    await writeFile(join(root, "server", "page.tsx"), `
      import * as helpers from "../shared/classes";
      const sizes = { small: "w-[47px]", large: "w-[123px]" };
      const heights = ["h-[71px]", "h-[83px]"];
      const styles = { spacing() { return "p-[17px]"; } };
      const secret = 'content-["selection-private-canary"]';
      export function Page({wide, size}: {wide: boolean; size: "small" | "large"}) {
        let assigned;
        if (wide) assigned = "m-[11px]"; else assigned = "m-[19px]";
        return <main class={helpers.classes(sizes[size], assigned, styles.spacing(), "gap-[23px]")}>
          <p class={sizes[wide ? "small" : "large"]}/><p class={heights[0]}/><p class={heights[wide ? 0 : 1]}/>
          <p class={secret ? "z-[31]" : "z-[37]"}/>
        </main>;
      }
    `);
    const bundle = await compileClient(await admitProject(root));
    const css = String(bundle.files.get(bundle.stylesheet!)?.body);
    for (const [property, values] of [["width", [47, 123]], ["height", [71, 83]], ["padding", [17]], ["margin", [11, 19]], ["gap", [23]]] as const) {
      for (const value of values) expect(css).toMatch(new RegExp(`${property}:\\s*${value}px`));
    }
    expect(css).not.toContain("selection-private-canary");
    expect(css).toMatch(/z-index:\s*31/);
    expect(css).toMatch(/z-index:\s*37/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("class bindings support destructuring and defaults without confusing shadowed server data", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-class-bindings-"));
  try {
    await mkdir(join(root, "server"));
    await writeFile(join(root, "server", "page.tsx"), `
      const privateNote = 'content-["destructured-private-canary"]';
      const caught = 'content-["caught-private-canary"]';
      const local = 'content-["var-private-canary"]';
      const Inner = 'content-["class-private-canary"]';
      const [classes] = ["w-[173px]"];
      const base = ["w-[191px]"];
      const {hidden, ...props} = {hidden: 'content-["rest-private-canary"]', className: "w-[197px]"};
      function choose(value = "w-[179px]") { return value; }
      function fromObject({value}: {value: string; private: string}) { return value; }
      function fromArray([value]: string[]) { return value; }
      export function Page({privateNote}: {privateNote:string}) { return <main class={privateNote}><p class={classes}/><p class={choose()}/><p class={fromObject({value: "w-[183px]", private: 'content-["unselected-argument-canary"]'})}/><p class={fromArray(["w-[187px]"])}/><p class={[...base, "h-[193px]"].join(" ")}/><p {...props}/></main>; }
      export function Fallback() { try { throw "unknown runtime value"; } catch (caught) { return <main class={caught}/>; } }
      export function Hoisted() { if (true) { var local = "w-[181px]"; } return <main class={local}/>; }
      export const Component = class Inner { render() { return <main class={Inner}/>; } };
    `);
    const bundle = await compileClient(await admitProject(root));
    const css = String(bundle.files.get(bundle.stylesheet!)?.body);
    for (const canary of ["destructured-private-canary", "caught-private-canary", "var-private-canary", "class-private-canary", "unselected-argument-canary", "rest-private-canary"]) expect(css).not.toContain(canary);
    for (const width of [173, 179, 181, 183, 187, 191, 197]) expect(css).toMatch(new RegExp(`width:\\s*${width}px`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("spread indexing and computed rest keys retain only selected presentation values", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-class-projections-"));
  try {
    await mkdir(join(root, "server"));
    await writeFile(join(root, "server", "page.tsx"), `
      const pair = ["w-[211px]", 'content-["indexed-spread-private-canary"]'];
      const key = "className";
      const {[key]: omitted, ...props} = {class: "w-[223px]", className: 'content-["computed-rest-private-canary"]'};
      const choose = ({hidden, ...values}: {hidden: string; className: string}) => values;
      const choices = {small: "w-[241px]", large: "w-[251px]", private: 'content-["unselected-key-private-canary"]'};
      const typed = ["w-[257px]"] as const;
      export const Page = ({wide}: {wide: boolean}) => <main class={[...pair][0]}>
        <p {...props}/><p {...choose({hidden: 'content-["rest-argument-private-canary"]', className: "w-[227px]"})}/>
        <p class={[...["w-[229px]", "w-[233px]"], "w-[239px]"][2]}/>
        <p class={choices[wide ? "small" : "large"]}/>
        <p class={[...typed, 'content-["typed-spread-private-canary"]'][0]}/>
      </main>;
      export function Rest({hiddenKey}: {hiddenKey: "id" | "title"}) {
        const {[hiddenKey]: omitted, ...props} = {id: "a", title: "b", className: "w-[317px]"};
        return <p {...props}/>;
      }
    `);
    const bundle = await compileClient(await admitProject(root));
    const css = String(bundle.files.get(bundle.stylesheet!)?.body);
    for (const canary of ["indexed-spread-private-canary", "computed-rest-private-canary", "rest-argument-private-canary", "unselected-key-private-canary", "typed-spread-private-canary"]) expect(css).not.toContain(canary);
    for (const width of [211, 223, 227, 239, 241, 251, 257, 317]) expect(css).toMatch(new RegExp(`width:\\s*${width}px`));
    for (const width of [229, 233]) expect(css).not.toMatch(new RegExp(`width:\\s*${width}px`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("client compiler independently refuses import-meta asset transforms instead of embedding unsnapshotted server files", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-transform-guard-"));
  try {
    await mkdir(join(root, "server"));
    await mkdir(join(root, "client"));
    await writeFile(join(root, "server", "private.ts"), 'export const secret = "admitted-server-canary";');
    const path = join(root, "client", "view.ts");
    await writeFile(path, 'export const label = "safe";');
    const admitted = await admitProject(root);
    const canonical = admitted.client[0]!;
    const sources = new Map(admitted.sources);
    sources.set(canonical, 'export const leaked = new URL("../server/private.ts", import.meta.url).href;');
    await writeFile(join(root, "server", "private.ts"), 'export const secret = "unsnapshotted-server-canary";');
    const outcome = await compileClient({ ...admitted, sources }).then(bundle => ({ bundle, error: undefined }), (error: Error) => ({ bundle: undefined, error }));
    if (outcome.bundle) {
      const output = [...outcome.bundle.files.values()].map(file => typeof file.body === "string" ? file.body : new TextDecoder().decode(file.body)).join("\n");
      const decoded = [...output.matchAll(/data:[^"'\s,]+;base64,([A-Za-z0-9+/=]+)/g)].map(match => Buffer.from(match[1]!, "base64").toString("utf8")).join("\n");
      expect(decoded).not.toContain("unsnapshotted-server-canary");
    }
    expect(outcome.error?.message).toBe("SOURCE_REJECTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source admission rejects executable presentation files before either build can consume them", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-active-asset-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "badge.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("client and worker builds use admitted local media bytes and URL imports after files change", async () => {
  const { compileWorker } = await import("../../src/runtime/build/worker");
  const root = await mkdtemp(join(tmpdir(), "fleur-media-snapshot-"));
  try {
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "client"));
    const original = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>';
    await writeFile(join(root, "assets", "badge.svg"), original);
    await writeFile(join(root, "client", "badge.tsx"), 'import badge from "../assets/badge.svg"; export const Badge = () => <img src={badge}/>;');
    const admitted = await admitProject(root);
    await writeFile(join(root, "assets", "badge.svg"), '<svg onload="alert(1)"></svg>');
    const client = await compileClient(admitted), worker = await compileWorker(admitted);
    const asset = client.files.get("/assets/badge.svg");
    expect(asset?.type).toBe("image/svg+xml");
    expect(new TextDecoder().decode(asset?.body as Uint8Array)).toBe(original);
    expect(worker).toContain("/assets/badge.svg");
    expect([...client.files.values()].map(file => String(file.body)).join("\n")).not.toContain('onload="alert(1)"');
    expect(asset?.cache).toBe("no-cache");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("presentation admission rejects stylesheet and executable suffixes, disguised documents and asset symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-media-denial-"));
  try {
    await mkdir(join(root, "assets"));
    const invalid = [
      ["badge.svg", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>HTML</div></foreignObject></svg>'],
      ["badge.svg", '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.invalid/icon.svg#icon"/></svg>'],
      ["badge.svg", '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>'],
      ["badge.svg", '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:red}</style></svg>'],
      ["badge.png", '<html><script>alert(1)</script></html>'],
      ["badge.svg.js", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ["theme.css", 'body {color:red}'],
      ["code.js", 'export const value = 1'],
      ["badge.svg?raw", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ];
    for (const [name, content] of invalid) {
      const path = join(root, "assets", name!);
      await writeFile(path, content!);
      await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
      await rm(path);
    }
    const path = join(root, "outside.svg");
    await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await symlink(path, join(root, "assets", "badge.svg"));
    await expect(admitProject(root)).rejects.toThrow("SOURCE_REJECTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("served production bundles apply Tailwind and dynamic JSX custom properties while loading inert media", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-styled-browser-"));
  let server: ReturnType<typeof serveReadApplication> | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    await mkdir(join(root, "client"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "badge.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="red"/></svg>');
    await writeFile(join(root, "client", "styled.tsx"), `
      import { defineIsland } from "fleur/client";
      import { schema } from "fleur/schema";
      import { useState } from "preact/hooks";
      import badge from "../assets/badge.svg";
      export const Styled = defineIsland({ props: schema.object({}), component() {
        const [small, setSmall] = useState(false);
        return <div><button id="styled" class={small ? "w-[47px]" : "w-[123px]"} style={{ "--accent": small ? "rgb(0,0,255)" : "rgb(255,0,0)", color: "var(--accent)" }} onClick={() => setSmall(!small)}>Toggle</button><img id="local-media" src={badge}/><img id="cdn-media" src="https://cdn.example.invalid/badge.png"/></div>;
      }});
    `);
    const bundle = await compileClient(await admitProject(root));
    const application = {
      prepareWorkers() {}, registry: { queries: new Map() },
      async revision() { return { epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }; },
      async watch() { return async () => {}; },
      async render() { return { html: '<div data-fleur-island="island-0" data-fleur-identity="styled"><div><button id="styled" class="w-[123px]" style="--accent:rgb(255,0,0);color:var(--accent)">Toggle</button><img id="local-media" src="/assets/badge.svg"><img id="cdn-media" src="https://cdn.example.invalid/badge.png"></div></div>', islands: [{ key: "island-0", id: "client/styled.tsx#Styled", props: {} }], regions: [] }; },
    } as unknown as ReadApplication;
    server = serveReadApplication(application, bundle);
    const page = await browser.newPage();
    await page.route("https://cdn.example.invalid/badge.png", route => route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1EAAAAASUVORK5CYII=", "base64") }));
    await page.goto(server.url.origin);
    await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
    const appearance = () => page.locator("#styled").evaluate(element => ({ width: getComputedStyle(element).width, color: getComputedStyle(element).color }));
    expect(await appearance()).toEqual({ width: "123px", color: "rgb(255, 0, 0)" });
    await page.locator("#styled").click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("styled")!).width === "47px");
    expect(await appearance()).toEqual({ width: "47px", color: "rgb(0, 0, 255)" });
    expect(await page.locator("#local-media").evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(10);
    expect(await page.locator("#cdn-media").evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  } finally { await browser.close(); await server?.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);
