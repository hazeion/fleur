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
