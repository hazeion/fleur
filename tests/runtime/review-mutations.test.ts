import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Isolate module replacements from the real PostgreSQL/native integration suite.
test("an uncertain commit remains uncertain when releasing its execution reservation also fails", async () => {
  const application = fileURLToPath(new URL("../../src/runtime/application.ts", import.meta.url));
  const broker = fileURLToPath(new URL("../../src/runtime/database/broker.ts", import.meta.url));
  const execution = fileURLToPath(new URL("../../src/runtime/native/execution.ts", import.meta.url));
  const script = `
    import { mock } from "bun:test";
    mock.module(${JSON.stringify(broker)}, () => ({ ReadBroker: class {
      async mutate() { throw new Error("OUTCOME_UNKNOWN"); }
      async close() {}
    } }));
    mock.module(${JSON.stringify(execution)}, () => ({ NativeExecution: { open: () => ({
      async reserve() { return { run: async () => { throw new Error("unexpected run"); }, release() { throw new Error("ATTACH_EXIT_UNCONFIRMED"); } }; },
    }) } }));
    const { ReadApplication } = await import(${JSON.stringify(application)});
    const app = new ReadApplication({}, { tables: [], mutations: new Map([["save", { input: { parse: value => value } }]]) }, "unused");
    try { await app.mutate("save", {}); process.exitCode = 1; }
    catch (error) { console.log(error.message); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe("OUTCOME_UNKNOWN");
});
