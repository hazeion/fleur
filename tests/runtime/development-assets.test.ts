import { expect, test } from "bun:test";
import type { BrowserBuild } from "../../src/runtime/build/client";
import { DevelopmentAssets } from "../../src/runtime/development/assets";

// Public lifecycle resource operation, observed through HTTP. This proves neither
// project ownership nor compiler admission, which have separate public dev tests.
for (let repeat = 1; repeat <= 2; repeat++) test(`retained browser assets survive many generations and capacity refusal leaves the current view usable, repeat ${repeat}`, async () => {
  const assets = new DevelopmentAssets(64);
  let current: BrowserBuild | undefined;
  const build = (name: string, body: string): BrowserBuild => ({ entry: `/assets/${name}.js`, files: new Map([[`/assets/${name}.js`, { body, type: "text/javascript" }]]) });
  const publish = (next: BrowserBuild) => { const commit = assets.prepare(next); commit(); current = next; };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname, asset = current?.files.get(path) ?? assets.get(path);
    return asset ? new Response(typeof asset.body === "string" ? asset.body : new Uint8Array(asset.body).buffer, { headers: { "Content-Type": asset.type } }) : new Response(null, { status: 404 });
  } });
  try {
    for (let generation = 1; generation <= 5; generation++) publish(build(String(generation), `/* ${generation} */`));
    expect(await (await fetch(new URL("/assets/1.js", server.url))).text()).toBe("/* 1 */");
    expect(await (await fetch(new URL("/assets/5.js", server.url))).text()).toBe("/* 5 */");
    expect(() => publish(build("refused", "x".repeat(65)))).toThrow("BROWSER_ASSET_CAPACITY");
    expect((await fetch(new URL("/assets/refused.js", server.url))).status).toBe(404);
    expect(await (await fetch(new URL("/assets/5.js", server.url))).text()).toBe("/* 5 */");
    expect(() => publish(build("1", "different bytes"))).toThrow("SOURCE_REJECTED");
    expect(await (await fetch(new URL("/assets/1.js", server.url))).text()).toBe("/* 1 */");
    const first = assets.prepare(build("six", "a".repeat(20))), second = assets.prepare(build("seven", "b".repeat(20)));
    first(); expect(second).toThrow("BROWSER_ASSET_CAPACITY");
    expect((await fetch(new URL("/assets/seven.js", server.url))).status).toBe(404);
  } finally { await server.stop(true); }
});
