import { expect, test } from "bun:test";

const setup = `
  import { mock } from "bun:test";
  const endpoint = "unix:///var/run/docker.sock";
  const calls = [];
  let switchContext = true;
  process.env.DOCKER_HOST = "tcp://untrusted.invalid:2375";
  process.env.DOCKER_CONTEXT = "untrusted-context";
  const observe = (args, options = {}) => {
    const environment = options.env ?? process.env;
    calls.push({ args, context: environment.DOCKER_CONTEXT ?? null, host: environment.DOCKER_HOST ?? null });
    if (switchContext) {
      process.env.DOCKER_HOST = "tcp://changed.invalid:2375";
      process.env.DOCKER_CONTEXT = "changed-context";
    }
    if (args.includes("info")) return "x86_64";
    if (args.includes("image")) return "sha256:" + (args.some(value => value.endsWith("-worker")) ? "a" : "b").repeat(64);
    if (args.includes("context")) return args.includes("show") ? "default" : JSON.stringify({ Host: endpoint });
    return "";
  };
  mock.module("./src/setup/host.ts", () => ({ productionHost: () => ({
    environment: { ...process.env },
    run: async (args, timeout, context) => ({ status: "completed", exitCode: 0,
      stdout: observe(args, { env: args.includes("--host") ? { ...process.env, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined } : process.env }), stderr: "" }),
  }) }));
  const textStream = value => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } });
  const originalSpawn = Bun.spawn;
`;

function isolated(script: string): { calls: { args: string[]; context: string | null; host: string | null }[]; endpoint?: string } {
  const result = Bun.spawnSync([process.execPath, "-e", setup + script], {
    cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function expectBound(calls: ReturnType<typeof isolated>["calls"], expected?: string): void {
  const operations = calls.filter(call => call.args[0] === "docker" && !call.args.includes("context"));
  expect(operations.length).toBeGreaterThan(0);
  const endpoints = operations.map(call => call.args[call.args.indexOf("--host") + 1]);
  expect(endpoints.every(value => typeof value === "string" && value.startsWith("unix:///"))).toBe(true);
  expect(new Set(endpoints).size).toBe(1);
  if (expected) expect(endpoints[0]).toBe(expected);
  expect(operations.every(call => call.context === null && call.host === null)).toBe(true);
}

test("image preparation binds every Docker operation to one local endpoint", () => {
  const result = isolated(`
    Bun.spawn = (args, options) => ({ stdout: textStream(observe(args, options)), stderr: textStream(""), exited: Promise.resolve(0) });
    const { prepareNativeImages } = await import("./src/runtime/native/build.ts");
    const images = await prepareNativeImages("module.exports.run = async () => null;");
    console.log(JSON.stringify({ calls, endpoint: images.endpoint }));
  `);
  expectBound(result.calls, result.endpoint);
  expect(result.endpoint?.startsWith("unix:///")).toBe(true);
});

test("worker launch ignores changed ambient Docker context and uses the image endpoint", () => {
  const result = isolated(`
    mock.module("./src/runtime/native/lease.ts", () => ({ NativeLease: { create: async () => ({ beginCreation: async () => {}, bindWorker: async () => {}, cleanup: async () => {} }) } }));
    Bun.spawn = (args, options) => {
      observe(args, options);
      const value = new TextEncoder().encode(JSON.stringify({ kind: "ready", worker: { id: "c".repeat(64), pid: 123, boot: "11111111-1111-1111-1111-111111111111" } }));
      const bytes = new Uint8Array(value.length + 4); new DataView(bytes.buffer).setUint32(0, value.length); bytes.set(value, 4);
      return { stdout: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        stdin: { end: async () => {}, write: () => {}, flush: async () => {} }, exitCode: 0, exited: Promise.resolve(0) };
    };
    const { startWorker } = await import("./src/runtime/native/host.ts");
    const worker = await startWorker({ worker: "sha256:" + "a".repeat(64), controller: "sha256:" + "b".repeat(64), endpoint });
    await worker.close();
    console.log(JSON.stringify({ calls, endpoint }));
  `);
  expectBound(result.calls, result.endpoint);
});

test("lease cleanup after controller loss retains its original local endpoint", () => {
  const result = isolated(`
    const { NativeLease } = await import("./src/runtime/native/lease.ts");
    const lease = await NativeLease.create("00000000-0000-0000-0000-000000000000", {
      worker: "sha256:" + "a".repeat(64), controller: "sha256:" + "b".repeat(64), endpoint,
    });
    process.env.DOCKER_CONTEXT = "replacement-context";
    process.env.DOCKER_HOST = "tcp://replacement.invalid:2375";
    const recovered = await NativeLease.recover(lease.recoveryDirectory);
    await recovered.cleanup();
    console.log(JSON.stringify({ calls, endpoint }));
  `);
  expectBound(result.calls, result.endpoint);
});

test("image preparation refuses a remote Docker host before any image operation", () => {
  const result = isolated(`
    switchContext = false;
    delete process.env.DOCKER_CONTEXT;
    const { prepareNativeImages } = await import("./src/runtime/native/build.ts");
    let refusal;
    try { await prepareNativeImages("module.exports.run = async () => null;"); }
    catch (error) { refusal = error.message; }
    console.log(JSON.stringify({ calls, endpoint: refusal }));
  `);
  expect(result.endpoint).toBe("LOCAL_ENDPOINT_REQUIRED");
  expect(result.calls.every(call => call.args.includes("context"))).toBe(true);
});

test("worker close retries lease cleanup after a transient control refusal", () => {
  const result = isolated(`
    let attempts = 0;
    mock.module("./src/runtime/native/lease.ts", () => ({ NativeLease: { create: async () => ({
      beginCreation: async () => {}, bindWorker: async () => {}, cleanup: async () => { if (++attempts === 1) throw new Error("CONTROL_UNCONFIRMED"); },
    }) } }));
    Bun.spawn = (args, options) => {
      observe(args, options);
      const value = new TextEncoder().encode(JSON.stringify({ kind: "ready", worker: { id: "c".repeat(64), pid: 123, boot: "11111111-1111-1111-1111-111111111111" } }));
      const bytes = new Uint8Array(value.length + 4); new DataView(bytes.buffer).setUint32(0, value.length); bytes.set(value, 4);
      return { stdout: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        stdin: { end: async () => {}, write: () => {}, flush: async () => {} }, exitCode: 0, exited: Promise.resolve(0) };
    };
    const { startWorker } = await import("./src/runtime/native/host.ts");
    const worker = await startWorker({ worker: "sha256:" + "a".repeat(64), controller: "sha256:" + "b".repeat(64), endpoint });
    let refusal;
    try { await worker.close(); } catch (error) { refusal = error.message; }
    if (refusal !== "CONTROL_UNCONFIRMED") throw new Error("missing first cleanup refusal");
    await worker.close();
    if (attempts !== 2) throw new Error("cleanup was not retried");
    console.log(JSON.stringify({ calls, endpoint }));
  `);
  expectBound(result.calls, result.endpoint);
});
