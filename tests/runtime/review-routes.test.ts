import { expect, test } from "bun:test";
import { ownedPostgres } from "./owned-postgres";
import { fileURLToPath } from "node:url";

test("a static route wins before an overlapping dynamic route validates its parameters", async () => {
  // The subprocess isolates the native transport mock from other runtime tests.
  // Startup now verifies real control authority; route rendering performs no reads.
  const fixture = await ownedPostgres();
  try {
  const child = Bun.spawn([process.execPath, "-e", `
    import { mock } from "bun:test";
    import { h } from "preact";
    import { schema } from "./src/schema.ts";
    import { definePage } from "./src/routing.ts";
    import { registerPage } from "./src/server.ts";
    import { makeRunner } from "./src/runtime/worker-entry.ts";
    import { workerManifest } from "./src/runtime/worker-manifest.ts";
    const dynamic = definePage({ path: "/review-items/:id", params: schema.object({ id: schema.uuid() }) });
    const fixed = definePage({ path: "/review-items/new", params: schema.object({}) });
    registerPage(dynamic, { component: ({ params }) => h("h1", null, params.id) });
    registerPage(fixed, { component: () => h("h1", null, "New item") });
    const declarations = { dynamic, fixed };
    const manifest = workerManifest(declarations);
    mock.module("./src/runtime/native/host.ts", () => ({ startWorker: async () => ({
      close: async () => {},
      run: async (command, exchange) => {
        if (command.mode === "register") return makeRunner(declarations)(command, () => { throw new Error("unexpected exchange"); });
        const registry = await exchange({ kind: "registry", session: command.session, sequence: 0, value: manifest });
        return makeRunner(declarations)(command, request => {
          if (request.kind === "registry") return registry;
          throw new Error("unexpected exchange");
        });
      },
    }) }));
    const { ReadApplication } = await import("./src/runtime/application.ts");
    const app = await ReadApplication.open({ worker: "sha256:" + "a".repeat(64), controller: "sha256:" + "b".repeat(64), endpoint: "unix:///var/run/docker.sock" }, process.env.FLEUR_PRIVATE_DATABASE_URL);
    const observations = [];
    try {
      for (const path of ["/review-items/new", "/review-items/00000000-0000-4000-8000-000000000001", "/review-items/not-a-uuid"]) {
        try { observations.push({ path, result: await app.render(path) }); }
        catch (error) { observations.push({ path, error: error.message }); }
      }
    } finally { await app.close(); }
    console.log(JSON.stringify(observations));
  `], { env: { ...process.env, FLEUR_PRIVATE_DATABASE_URL: fixture.url }, cwd: fileURLToPath(new URL("../..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toEqual([
    { path: "/review-items/new", result: { html: '<template data-fleur-region="page"></template><h1>New item</h1><template data-fleur-end="page"></template>', islands: [], regions: [{ id: "page", dependencies: [] }] } },
    { path: "/review-items/00000000-0000-4000-8000-000000000001", result: { html: '<template data-fleur-region="page"></template><h1>00000000-0000-4000-8000-000000000001</h1><template data-fleur-end="page"></template>', islands: [], regions: [{ id: "page", dependencies: [] }] } },
    { path: "/review-items/not-a-uuid", error: "ROUTE_INVALID" },
  ]);
  } finally { await fixture.cleanup(); }
}, 180_000);
