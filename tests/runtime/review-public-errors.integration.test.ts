import { expect, test } from "bun:test";
import { ownedPostgres } from "./owned-postgres";

test("declared errors survive query and nested page boundaries while unexpected errors stay private", async () => {
  const fixture = await ownedPostgres();
  try {
    // Only the native transport is replaced. The application, broker transaction,
    // registration, worker entry, query handler, page and readQuery are real.
    const child = Bun.spawn([process.execPath, "-e", `
      import { mock } from "bun:test";
      import { h } from "preact";
      import { defineQuery, schema } from "./src/schema.ts";
      import { definePage } from "./src/routing.ts";
      import { handleQuery, registerPage, readQuery, publicError, inputError } from "./src/server.ts";
      import { makeRunner } from "./src/runtime/worker-entry.ts";
      import { workerManifest } from "./src/runtime/worker-manifest.ts";
      const query = defineQuery({ name: "review.error-chain", input: schema.object({ kind: schema.string() }), output: schema.string() });
      handleQuery(query, async ({ input }) => {
        if (input.kind === "missing") throw publicError("NOT_FOUND", { resource: "exercise" });
        if (input.kind === "invalid") throw inputError({ name: "A name is required." });
        throw new Error("PRIVATE_SQL_PASSWORD_CANARY");
      });
      const page = definePage({ path: "/errors/:kind", params: schema.object({ kind: schema.string() }) });
      registerPage(page, { component: async ({ params }) => h("main", null, await readQuery(query, params)) });
      const declarations = { query, page };
      const manifest = workerManifest(declarations);
      const fakeWorker = async () => ({
        close: async () => {},
        run: async (command, exchange) => {
          if (command.mode === "register") return makeRunner(declarations)(command, () => { throw new Error("unexpected exchange"); });
          const registry = await exchange({ kind: "registry", session: command.session, sequence: 0, value: manifest });
          const response = command.mode === "render" ? await exchange({ kind: "query", session: command.session, sequence: 1,
            value: { name: query.name, input: { kind: command.path.split("/").at(-1) } } }) : undefined;
          return makeRunner(declarations)(command, request => {
            if (request.kind === "registry") return registry;
            if (request.kind === "query") return response;
            throw new Error("unexpected exchange");
          });
        },
      });
      mock.module("./src/runtime/native/host.ts", () => ({ startWorker: fakeWorker }));
      mock.module("./src/runtime/native/execution.ts", () => ({ NativeExecution: { open: () => ({ warm() {}, async close() {},
        async reserve() { const worker = await fakeWorker(); return { deadline: performance.now() + 5000, run: async (command, exchange) => ({ value: await worker.run(command, exchange) }), release() {} }; } }) } }));

      const { ReadApplication } = await import("./src/runtime/application.ts");
      const app = await ReadApplication.open({ worker: "sha256:" + "a".repeat(64), controller: "sha256:" + "b".repeat(64), endpoint: "unix:///var/run/docker.sock" }, process.env.FLEUR_REVIEW_PG_URL);
      const observations = [];
      try {
        for (const mode of ["query", "page"]) for (const kind of ["missing", "invalid", "unexpected"]) {
          try {
            await (mode === "query" ? app.query(query.name, { kind }) : app.render("/errors/" + kind));
            observations.push({ mode, kind, resolved: true });
          } catch (error) {
            observations.push({ mode, kind, code: error.code ?? error.message, details: error.details ?? null, message: error.message });
          }
        }
      } finally { await app.close(); }
      console.log(JSON.stringify(observations));
    `], { cwd: new URL("../..", import.meta.url).pathname, env: { ...process.env, FLEUR_REVIEW_PG_URL: fixture.url }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(stdout).not.toContain("PRIVATE_SQL_PASSWORD_CANARY");
    const observations = JSON.parse(stdout) as { mode: string; kind: string; code: string; details: unknown }[];
    for (const mode of ["query", "page"]) {
      expect(observations.find(item => item.mode === mode && item.kind === "missing")).toMatchObject({ code: "NOT_FOUND", details: { resource: "exercise" } });
      expect(observations.find(item => item.mode === mode && item.kind === "invalid")).toMatchObject({ code: "INPUT_INVALID", details: { name: "A name is required." } });
      expect(observations.find(item => item.mode === mode && item.kind === "unexpected")).toMatchObject({ code: "INTERNAL_FAILURE", details: null });
    }
  } finally { await fixture.cleanup(); }
}, 300_000);
