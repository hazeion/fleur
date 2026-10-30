import { afterAll, beforeAll, expect, test } from "bun:test";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { nativeCommand } from "../../src/runtime/native/command";
import { NativeExecution, type ExecutionResult } from "../../src/runtime/native/execution";

// Each operation's process reports module and realm state. A retained
// application realm would report counts above one on a later operation.
const source = `
let moduleState = 0;
module.exports.run = async (request, exchange) => {
  moduleState++; globalThis.realmState = (globalThis.realmState || 0) + 1;
  if (request.spin) for (;;) {}
  if (request.garbage) { console.log("not a protocol frame"); for (;;) {} }
  if (request.denied) return { kind: "complete", value: {
    file: await Bun.file("/etc/passwd").text().then(() => false, () => true),
    secret: process.env.FLEUR_PRIVATE_DATABASE_URL ?? null } };
  if (request.echo) return { kind: "complete", value: await exchange({ echo: request.echo }) };
  return { kind: "complete", value: { module: moduleState, realm: globalThis.realmState } };
};`;
let images: Awaited<ReturnType<typeof prepareNativeImages>>;
beforeAll(async () => { images = await prepareNativeImages(source); }, 300_000);
afterAll(async () => { await images?.dispose(); }, 60_000);

async function owned(owner: string): Promise<string> {
  return nativeCommand(["docker", "--host", images.endpoint, "ps", "--all", "--quiet", "--filter", `label=dev.fleur.execution-owner=${owner}`]);
}
const identity = (result: ExecutionResult) => `${result.operation.process.pid}:${result.operation.process.start}`;

for (let repeat = 1; repeat <= 2; repeat++) test(`one retained container runs fresh restricted processes that retire before reuse, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const results: ExecutionResult[] = [];
    for (let index = 0; index < 3; index++) results.push(await execution.execute({}, () => null));
    expect(new Set(results.map(result => result.operation.container)).size).toBe(1);
    expect(new Set(results.map(identity)).size).toBe(3);
    expect(new Set(results.map(result => result.operation.id)).size).toBe(3);
    for (const result of results) {
      expect(result.value).toEqual({ kind: "complete", value: { module: 1, realm: 1 } });
      expect(result.evidence).toMatchObject({ physical_exit_confirmed: true, retired: true, outcome: "premature-exit" });
      expect(result.evidence.kill_lateness_ms).toBeLessThanOrEqual(250);
      for (const phase of ["launch", "audit", "guard", "execute", "retire"]) expect(result.timings[phase]).toBeGreaterThanOrEqual(0);
    }
    // Two-way exchange is relayed only through the trusted host callback.
    expect((await execution.execute({ echo: "ping" }, request => ({ answered: request }))).value).toEqual({ kind: "complete", value: { answered: { echo: "ping" } } });
    console.info("[retained-execution-timings]", JSON.stringify(results.map(result => result.timings)));
  } finally { await execution.close(); }
}, 120_000);

test("existing filesystem and secret negative controls hold in every retained process", async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    for (let index = 0; index < 2; index++) expect((await execution.execute({ denied: true }, () => null)).value).toEqual({ kind: "complete", value: { file: true, secret: null } });
  } finally { await execution.close(); }
}, 120_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`a busy operation is retired at its deadline without stalling a sibling, then its container is reused, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 2 });
  try {
    await Promise.all([execution.execute({}, () => null), execution.execute({}, () => null)]);
    const started = performance.now();
    const busy = execution.execute({ spin: true }, () => null, 1500).then(() => { throw new Error("busy operation completed"); }, (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 200));
    const healthy = await execution.execute({}, () => null);
    expect(healthy.value).toEqual({ kind: "complete", value: { module: 1, realm: 1 } });
    expect(performance.now() - started).toBeLessThan(1500);
    const failure = await busy as Error & { evidence?: Record<string, unknown>; operation?: { container: string } };
    expect(failure.message).toBe("QUERY_TIMEOUT");
    expect(failure.evidence).toMatchObject({ physical_exit_confirmed: true, retired: true, outcome: "deadline" });
    expect(Number(failure.evidence?.physical_exit_lateness_ms)).toBeLessThanOrEqual(250);
    const containers = new Set([healthy.operation.container, failure.operation?.container]);
    expect(containers.size).toBe(2);
    // Verified retirement returns the busy container to service.
    const reused = await Promise.all([execution.execute({}, () => null), execution.execute({}, () => null)]);
    expect(new Set<string | undefined>(reused.map(result => result.operation.container))).toEqual(containers);
  } finally { await execution.close(); }
}, 120_000);

test("malformed application output fails only its own operation after verified retirement", async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    const failure = await execution.execute({ garbage: true }, () => null).then(() => undefined, (error: unknown) => error as Error & { evidence?: Record<string, unknown> });
    expect(failure?.message).toBe("INTERNAL_FAILURE");
    expect(failure?.evidence).toMatchObject({ physical_exit_confirmed: true, retired: true, outcome: "cancelled" });
    const next = await execution.execute({}, () => null);
    expect(next.operation.container).toBe(first.operation.container);
    expect(next.value).toEqual({ kind: "complete", value: { module: 1, realm: 1 } });
  } finally { await execution.close(); }
}, 120_000);

test("controller loss kills its bound operation, quarantines the slot and verified cleanup removes it", async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    const busy = execution.execute({ spin: true }, () => null).then(() => undefined, (error: unknown) => error as Error);
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline && execution.diagnostics()[0]?.state !== "running") await new Promise(resolve => setTimeout(resolve, 10));
    expect(execution.diagnostics()[0]?.state).toBe("running");
    const killedAt = performance.now();
    await nativeCommand(["docker", "--host", images.endpoint, "kill", `fleur-exec-controller-${first.operation.slot}`]);
    expect(await busy).toBeInstanceOf(Error);
    // Guard EOF kills the application long before its five-second deadline.
    expect(performance.now() - killedAt).toBeLessThan(4000);
    const recovered = performance.now() + 15_000;
    while (performance.now() < recovered && await owned(first.operation.slot)) await new Promise(resolve => setTimeout(resolve, 100));
    expect(await owned(first.operation.slot)).toBe("");
    const next = await execution.execute({}, () => null);
    expect(next.operation.slot).not.toBe(first.operation.slot);
    expect(next.value).toEqual({ kind: "complete", value: { module: 1, realm: 1 } });
  } finally { await execution.close(); }
}, 120_000);

test("close drains admission and removes every owned container", async () => {
  const execution = await NativeExecution.open(images, { capacity: 2 });
  const slots = new Set<string>();
  try {
    execution.warm();
    for (const result of await Promise.all([execution.execute({}, () => null), execution.execute({}, () => null)])) slots.add(result.operation.slot);
  } finally { await execution.close(); }
  await expect(execution.execute({}, () => null)).rejects.toThrow("APPLICATION_CLOSED");
  for (const slot of slots) expect(await owned(slot)).toBe("");
}, 120_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`a bounded close reports uncertain retirement without reopening admission or dropping ownership, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    await execution.execute({}, () => null);
    const started = performance.now();
    await expect(execution.close(1)).rejects.toThrow("EXECUTION_RECOVERY_REQUIRED");
    expect(performance.now()-started).toBeLessThan(1000);
    await expect(execution.execute({}, () => null)).rejects.toThrow("APPLICATION_CLOSED");
    // Until physical retirement is verified, diagnostics must retain capacity.
    const diagnostics = execution.diagnostics();
    expect(diagnostics).toHaveLength(1);
    for (const slot of diagnostics) expect(slot.state).not.toBe("closed");
  } finally { await execution.close(); }
}, 60000);

for (let repeat = 1; repeat <= 2; repeat++) test(`lost Docker retirement verification retains quarantined capacity until explicit verified recovery, repeat ${repeat}`, async () => {
  const { createServer, connect } = await import("node:net");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fleur-retire-proxy-")), socket = join(directory, "docker.sock");
  let denied = false;
  const clients = new Set<import("node:net").Socket>();
  const proxy = createServer(client => {
    clients.add(client); client.on("close", () => clients.delete(client));
    if (denied) { client.destroy(); return; }
    const daemon = connect(images.endpoint.slice("unix://".length));
    daemon.on("error", () => client.destroy()); client.on("error", () => daemon.destroy());
    client.on("close", () => daemon.destroy()); daemon.on("close", () => client.destroy());
    client.pipe(daemon); daemon.pipe(client);
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(socket, resolve); });
  let execution: NativeExecution | undefined, leaseDirectory: string | undefined;
  try {
    execution = await NativeExecution.open({ ...images, endpoint: "unix://"+socket }, { capacity: 1 });
    await execution.execute({}, () => null);
    const owner = execution.diagnostics()[0]!.slot;
    const { readdir, readFile } = await import("node:fs/promises");
    for (const name of await readdir(tmpdir())) if (name.startsWith("fleur-retained-lease-")) {
      try { const record = JSON.parse(await readFile(join(tmpdir(), name, "lease.json"), "utf8")); if (record.owner === owner && record.images.endpoint === "unix://"+socket) leaseDirectory = join(tmpdir(), name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    expect(leaseDirectory).toBeDefined();
    denied = true; // Actual control transport loss, never a fabricated successful Docker reply.
    await expect(execution.close()).rejects.toThrow("EXECUTION_RECOVERY_REQUIRED");
    expect(execution.diagnostics()).toMatchObject([{ slot: owner, state: "quarantined" }]);
    await expect(execution.execute({}, () => null)).rejects.toThrow("APPLICATION_CLOSED");
    denied = false;
    await execution.close();
    expect(execution.diagnostics()).toEqual([]);
    expect(await owned(owner)).toBe("");
  } finally {
    denied = false;
    try { await execution?.close(); }
    catch (error) {
      // Even a red assertion must retire only its exact private owned lease.
      expect(leaseDirectory, error instanceof Error ? error.message : "Retirement requires ownership evidence").toBeDefined();
      const { RetainedLease } = await import("../../src/runtime/native/retained-lease");
      await (await RetainedLease.recover(leaseDirectory!)).cleanup();
    }
    finally { for (const client of clients) client.destroy(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
  }
}, 120000);

test("cancelled application creation never opens a native execution owner", async () => {
  const cancellation = new AbortController(); cancellation.abort();
  let opened: NativeExecution | undefined;
  try {
    await expect(NativeExecution.open(images, { signal: cancellation.signal }).then(execution => { opened = execution; return execution; })).rejects.toThrow("APPLICATION_CLOSED");
  } finally { await opened?.close(); }
}, 60000);
