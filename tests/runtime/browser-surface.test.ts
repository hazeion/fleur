import { expect, test } from "bun:test";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { admitProject } from "../../src/runtime/build/admission";
import { compileClient } from "../../src/runtime/build/client";
import { serveReadApplication } from "../../src/runtime/http";
import type { ReadApplication } from "../../src/runtime/application";

const application = (html: string | (() => string)) => ({
  prepareWorkers() {}, registry: { queries: new Map() },
  async revision() { return { epoch: "00000000-0000-4000-8000-000000000000", revision: "0" }; },
  async watch() { return async () => {}; },
  async render() { return { html: typeof html === "function" ? html() : html, islands: [], regions: [] }; },
}) as unknown as ReadApplication;

test("browser runtime rejects authored stylesheet injection without relying on CSP", async () => {
  const bundle = await compileClient(await admitProject(fileURLToPath(new URL("fixtures/saves", import.meta.url))));
  const server = serveReadApplication(application("<main>Browser policy</main>"), bundle);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(server.url.origin + "/", async route => {
      const response = await route.fetch();
      const headers = response.headers();
      delete headers["content-security-policy"];
      await route.fulfill({ response, headers });
    });
    await page.goto(server.url.origin);
    await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
    expect(await page.locator('link[rel="stylesheet"]').count()).toBe(1);
    const result = await page.evaluate(() => {
      const probe = (run: () => unknown) => { try { run(); return "allowed"; } catch { return "denied"; } };
      const denied = {
        style: probe(() => document.createElement("style")),
        stylesheet: probe(() => document.createElement("link")),
        constructedSheet: probe(() => new CSSStyleSheet().replaceSync("body { color: red }")),
        adoptedSheets: probe(() => { document.adoptedStyleSheets = [new CSSStyleSheet()]; }),
        activeSvg: probe(() => document.createElementNS("http://www.w3.org/2000/svg", "foreignObject")),
        eventAttribute: probe(() => document.createElement("img").setAttribute("onerror", "window.bad = true")),
        codeHref: probe(() => { document.createElement("a").href = "javascript:window.bad=true"; }),
        codeSource: probe(() => { document.createElement("img").src = "data:image/svg+xml,<svg/>"; }),
        attrNode: probe(() => { const element = document.createElement("img"); element.setAttribute("src", "/assets/image.png"); element.attributes.getNamedItem("src")!.value = "data:image/svg+xml,<svg/>"; }),
        functionConstructor: probe(() => new Function("window.bad = true")()),
        indirectConstructor: probe(() => (() => {}).constructor("window.bad = true")()),
        stringTimer: probe(() => window.setTimeout("window.bad = true", 0)),
        fetch: probe(() => Reflect.get(window, "fetch")("/__fleur/view")),
        xhr: probe(() => new XMLHttpRequest()),
        socket: probe(() => new WebSocket("ws://127.0.0.1/")),
        beacon: probe(() => navigator.sendBeacon("/__fleur/mutation", "manual")),
        worker: probe(() => new Worker("/assets/client.js")),
        serviceWorker: probe(() => navigator.serviceWorker.register("/assets/client.js")),
        fontHttp: probe(() => new FontFace("Unapproved", 'url("http://example.invalid/font.woff2")')),
        ownedStylesheet: probe(() => { document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]')!.href = "https://example.invalid/injected.css"; }),
        ownedScript: probe(() => { document.querySelector<HTMLScriptElement>('script[type="module"]')!.src = "https://example.invalid/injected.js"; }),
      };
      const element = document.createElement("div");
      element.style.color = "rgb(10, 20, 30)";
      element.style.setProperty("--accent", "purple");
      document.body.append(element);
      const fonts = [new FontFace("Local", 'url("/assets/font.woff2")').status, new FontFace("CDN", 'url("https://example.invalid/font.woff2") format("woff2")').status];
      const attributeCoercions = ["textContent", "nodeValue"].map(property => {
        const link = document.createElement("a");
        link.href = "/safe";
        const attribute = link.getAttributeNode("href")!;
        let conversions = 0;
        Reflect.set(attribute, property, { toString() { return ++conversions === 1 ? "/safe" : "javascript:window.bad=true"; } });
        return { value: link.getAttribute("href"), conversions };
      });
      return { denied, fonts, attributeCoercions, color: getComputedStyle(element).color, accent: element.style.getPropertyValue("--accent") };
    });
    expect(result.denied).toEqual({ style: "denied", stylesheet: "denied", constructedSheet: "denied", adoptedSheets: "denied", activeSvg: "denied", eventAttribute: "denied", codeHref: "denied", codeSource: "denied", attrNode: "denied", functionConstructor: "denied", indirectConstructor: "denied", stringTimer: "denied", fetch: "denied", xhr: "denied", socket: "denied", beacon: "denied", worker: "denied", serviceWorker: "denied", fontHttp: "denied", ownedStylesheet: "denied", ownedScript: "denied" });
    expect(result.color).toBe("rgb(10, 20, 30)");
    expect(result.accent).toBe("purple");
    expect(result.fonts).toEqual(["unloaded", "unloaded"]);
    expect(result.attributeCoercions).toEqual([{ value: "/safe", conversions: 1 }, { value: "/safe", conversions: 1 }]);
  } finally { await browser.close(); await server.stop(true); }
}, 30_000);

test("CSP independently blocks code and stylesheets while allowing inline declarations and same-origin Fleur transport", async () => {
  const bundle = await compileClient(await admitProject(fileURLToPath(new URL("fixtures/saves", import.meta.url))));
  const server = serveReadApplication(application("<main>CSP policy</main>"), bundle);
  const browser = await chromium.launch({ headless: true });
  try {
    const checkPolicy = async (enabled: boolean) => {
      const page = await browser.newPage();
      // The no-policy run establishes that hostile resources really work. Keep
      // the same responses in both runs so a missing file is never the defense.
      const served: string[] = [];
      const resources = [
        { url: server.url.origin + "/unregistered.js", type: "text/javascript", body: "window.localResourceExecuted = true;" },
        { url: "https://policy.example.invalid/unregistered.js", type: "text/javascript", body: "window.externalResourceExecuted = true;" },
        { url: server.url.origin + "/unregistered.css", type: "text/css", body: "#local-style { color: rgb(56, 34, 12) }" },
        { url: "https://policy.example.invalid/unregistered.css", type: "text/css", body: "#external-style { color: rgb(12, 34, 56) }" },
      ];
      for (const resource of resources) await page.route(resource.url, async route => {
        served.push(resource.url);
        await route.fulfill({ status: 200, contentType: resource.type, headers: { "x-content-type-options": "nosniff" }, body: resource.body });
      });
      await page.route(server.url.origin + "/", async route => {
        const response = await route.fetch();
        const headers = response.headers();
        const policy = headers["content-security-policy"]!;
        const nonce = /'nonce-([^']+)'/.exec(policy)![1];
        if (!enabled) delete headers["content-security-policy"];
        // Keep the production CSP, but omit the runtime bundle entirely. These
        // probes execute normally as a trusted parser script, outside DevTools.
        await route.fulfill({ response, headers, body: `<!doctype html><html><head>
        <style>#sample { color: rgb(255, 0, 0) !important }</style>
        <link rel="stylesheet" href="/unregistered.css">
        <link rel="stylesheet" href="https://policy.example.invalid/unregistered.css">
        </head><body><div id="sample" style="color:rgb(10,20,30);--accent:purple">Safe</div>
        <div id="local-style">Local stylesheet probe</div>
        <div id="external-style">External stylesheet probe</div>
        <script>window.escape = true</script><script src="/unregistered.js"></script>
        <script src="https://policy.example.invalid/unregistered.js"></script>
        <script nonce="${nonce}">
          const probe = run => { try { run(); return 'allowed'; } catch { return 'denied'; } };
          window.policyProbe = {
            eval: probe(() => eval('window.escape=true')),
            constructor: probe(() => new Function('window.escape=true')()),
            transport: 'pending'
          };
          fetch('/').then(() => window.policyProbe.transport = 'allowed');
        </script></body></html>` });
      });
      await page.goto(server.url.origin);
      await page.waitForFunction(() => (window as unknown as { policyProbe: { transport: string } }).policyProbe.transport === "allowed");
      const result = await page.evaluate(() => {
        const state = window as unknown as { policyProbe: unknown; escape?: boolean; localResourceExecuted?: boolean; externalResourceExecuted?: boolean };
        const sample = document.getElementById("sample")!;
        return {
          probe: state.policyProbe, escaped: state.escape === true,
          localResourceExecuted: state.localResourceExecuted === true, externalResourceExecuted: state.externalResourceExecuted === true,
          localColor: getComputedStyle(document.getElementById("local-style")!).color,
          externalColor: getComputedStyle(document.getElementById("external-style")!).color,
          color: getComputedStyle(sample).color, accent: getComputedStyle(sample).getPropertyValue("--accent"),
        };
      });
      await page.close();
      expect(served.sort()).toEqual(enabled ? [] : resources.map(resource => resource.url).sort());
      return result;
    };
    expect(await checkPolicy(false)).toEqual({
      probe: { eval: "allowed", constructor: "allowed", transport: "allowed" }, escaped: true,
      localResourceExecuted: true, externalResourceExecuted: true,
      localColor: "rgb(56, 34, 12)", externalColor: "rgb(12, 34, 56)", color: "rgb(255, 0, 0)", accent: "purple",
    });
    expect(await checkPolicy(true)).toEqual({
      probe: { eval: "denied", constructor: "denied", transport: "allowed" }, escaped: false,
      localResourceExecuted: false, externalResourceExecuted: false,
      localColor: "rgb(0, 0, 0)", externalColor: "rgb(0, 0, 0)", color: "rgb(10, 20, 30)", accent: "purple",
    });
  } finally { await browser.close(); await server.stop(true); }
}, 30_000);

test("CSP permits prevented form-submit handlers while rejecting native form navigation", async () => {
  const bundle = await compileClient(await admitProject(fileURLToPath(new URL("fixtures/saves", import.meta.url))));
  const server = serveReadApplication(application('<form id="handled"><button>Handle</button></form><form id="native"><input name="form-proof" value="1"><button>Navigate</button></form>'), bundle);
  const browser = await chromium.launch({ headless: true });
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      const page = await browser.newPage();
      const nativeRequests: string[] = [];
      page.on("request", request => { if (new URL(request.url()).searchParams.has("form-proof")) nativeRequests.push(request.url()); });
      await page.goto(server.url.origin);
      await page.waitForFunction(() => document.documentElement.dataset.fleurHydrated === "true");
      await page.evaluate(() => {
        document.getElementById("handled")!.addEventListener("submit", event => {
          event.preventDefault(); document.documentElement.dataset.formHandled = "true";
        });
        document.addEventListener("securitypolicyviolation", event => {
          if (event.violatedDirective === "form-action") document.documentElement.dataset.nativeFormDenied = "true";
        });
      });
      await page.getByRole("button", { name: "Handle", exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.formHandled === "true", undefined, { timeout: 2000 });
      await page.getByRole("button", { name: "Navigate", exact: true }).click({ noWaitAfter: true });
      await page.waitForFunction(() => document.documentElement.dataset.nativeFormDenied === "true", undefined, { timeout: 2000 });
      expect(nativeRequests).toEqual([]);
      expect(page.url()).toBe(server.url.origin + "/");
      await page.close();
    }
  } finally { await browser.close(); await server.stop(true); }
}, 30_000);

test("server HTML rejects active presentation markup before navigation or refresh", async () => {
  const bundle = await compileClient(await admitProject(fileURLToPath(new URL("fixtures/saves", import.meta.url))));
  for (const html of [
    '<style>body{color:red}</style>',
    '<link rel="stylesheet" href="https://example.invalid/theme.css">',
    '<img src="/assets/photo.png" onerror="window.bad=true">',
    '<svg><foreignObject><div>Executable document</div></foreignObject></svg>',
    '<svg><a href="javascript:alert(1)"><text>Click</text></a></svg>',
    '<svg><set attributeName="href" to="javascript:alert(1)" /></svg>',
    '<base href="https://example.invalid/">',
    '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
  ]) {
    const server = serveReadApplication(application(html), bundle);
    try { expect((await fetch(server.url.origin)).status).toBe(500); }
    finally { await server.stop(true); }
  }
  const safe = serveReadApplication(application('<main style="color:rgb(10,20,30);--accent:purple"><svg><path d="M0 0 L10 10" /></svg><img src="https://cdn.example.invalid/photo.png"></main>'), bundle);
  try { expect((await fetch(safe.url.origin)).status).toBe(200); }
  finally { await safe.stop(true); }
  let html = "<main>Last admitted result</main>";
  const refresh = serveReadApplication(application(() => html), bundle);
  try {
    const request = (body: unknown) => fetch(new URL("/__fleur/view", refresh.url), { method: "POST", headers: { origin: refresh.url.origin, "content-type": "application/json", "x-fleur-request": "view" }, body: JSON.stringify(body) });
    const initial = await (await request({ action: "open", path: "/" })).json();
    html = '<style>body{color:red}</style>';
    const response = await request({ action: "refresh", connection: initial.connection, page: initial.page, generation: initial.generation, sequence: initial.sequence + 1, queries: [], force: true });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.renderError).toBe("INTERNAL_FAILURE");
    expect(updated.rendered.html).toBe("<main>Last admitted result</main>");
  } finally { await refresh.stop(true); }
}, 30_000);
