import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("shutdown during idle retirement closes starting workers without a false recovery failure", async () => {
  const host = fileURLToPath(new URL("../../src/runtime/native/host.ts", import.meta.url));
  const pool = fileURLToPath(new URL("../../src/runtime/native/prepared-workers.ts", import.meta.url));
  const script = `
    import { mock } from "bun:test";
    const starts = [], timers = [];
    let closed = 0;
    mock.module(${JSON.stringify(host)}, () => ({ startWorker: () => new Promise(resolve => starts.push(resolve)) }));
    globalThis.setTimeout = callback => { timers.push(callback); return { unref() {} }; };
    globalThis.clearTimeout = () => {};
    const { PreparedWorkers } = await import(${JSON.stringify(pool)});
    const workers = new PreparedWorkers({});
    workers.warm();
    timers[0]();
    const closing = workers.close();
    for (const start of starts) start({ close: async () => { closed++; } });
    await closing;
    console.log(closed);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr, stdout: stdout.trim() }).toEqual({ code: 0, stderr: "", stdout: "4" });
});
