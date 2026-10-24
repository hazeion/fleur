import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const nonce = "12345678-1234-1234-1234-123456789abc";
test("complete owned-group evidence stays bounded despite many unrelated host rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-scope-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(3);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "pending" });
    const queries = (await Bun.file(join(root, "inventory-queries.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(queries).toHaveLength(3);
    expect(queries.every((item) => item.selection === "owned-group")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


for (const scenario of ["selector-allocation", "selector-register", "selector-close"]) {
test(`inventory selector failure retires its actual owned probe and closes its stream: ${scenario}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-selector-fault-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: scenario } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed" });
    expect(await Bun.file(join(root, "actual-probe-created")).text()).toBe("created");
    expect(await Bun.file(join(root, "selector-fault-fired")).text()).toBe("after actual probe creation");
    // Await the bounded fixture backup even on the RED path; it cannot alter
    // the pre-backup source retirement evidence asserted below.
    const backupEnd = performance.now() + 3500;
    while (!await Bun.file(join(root, "fixture-backup-finished")).exists() && performance.now() < backupEnd) await Bun.sleep(10);
    expect(await Bun.file(join(root, "fixture-backup-finished")).text()).toBe("retired");
    expect(await Bun.file(join(root, "probe-retirement.json")).json()).toEqual({ sourceReaped: true, streamClosed: true });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
}


test("lost query custody refuses proof without signaling its actually reaped PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-lost-query-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: "lost-query-custody" } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed" });
    expect(await Bun.file(join(root, "actual-custody-loss.json")).json()).toEqual({ ownedProbeActuallyReaped: true });
    const backupEnd = performance.now() + 3500;
    while (!await Bun.file(join(root, "fixture-backup-finished")).exists() && performance.now() < backupEnd) await Bun.sleep(10);
    expect(await Bun.file(join(root, "fixture-backup-finished")).text()).toBe("retired");
    expect(await Bun.file(join(root, "released-probe-signal.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


for (const [scenario, reason] of [["owned-overcap", "inventory size"], ["malformed", "inventory schema"], ["missing-leader", "leader absent"], ["duplicate", "inventory identity"], ["linux-rows", "inventory size"], ["linux-no-waitid", "inventory size"]] as const) {
  test(`bounded inventory still refuses ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-inventory-refusal-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
      await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
      await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: scenario } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", error: { message: expect.stringContaining(reason) } });
      const queries = (await Bun.file(join(root, "inventory-queries.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every((item) => item.selection === (["linux-rows", "linux-no-waitid"].includes(scenario) ? "global" : "owned-group"))).toBe(true);
      if (scenario === "linux-no-waitid") {
        const capabilities = await Bun.file(join(root, "platform-capabilities.json")).json();
        expect(capabilities).toMatchObject({ actualHost: process.platform, waitidHidden: process.platform === "darwin", libSystemLoaded: process.platform === "darwin", controllerPlatform: process.platform, selectorPlatform: "linux", controllerWaitidAvailable: process.platform !== "darwin" });
        expect(typeof capabilities.initialWaitidAvailable).toBe("boolean");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10000);
}


test("late inventory setup cannot mint another one-second work window", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-absolute-end-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: "late-selector" } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(await Bun.file(join(root, "late-selector-finished")).text()).toBe("past original one-second work window");
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", error: { message: expect.stringContaining("inventory deadline") } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


test("a failed third release inventory cannot become accepted physical cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-release-failure-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: "release-third-malformed" } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(await Bun.file(join(root, "release-query-fault.json")).json()).toEqual({ ordinal: 3, actualProbeCreated: true });
    const queries = (await Bun.file(join(root, "inventory-queries.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(queries.map((item) => item.ordinal)).toEqual([1, 2, 3]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", error: { message: expect.stringContaining("inventory schema") }, transport: { cleanupConfirmed: false } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


test("a nonzero helper exit after genuine source release cannot authorize cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-helper-exit-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: "helper-nonzero-after-release" } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(await Bun.file(join(root, "source-release-completed.json")).json()).toEqual({ queries: 3, actualSshChildReaped: true, sourceExitCode: 0 });
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", error: { message: expect.stringContaining("relay exited 23") }, transport: { cleanupConfirmed: false } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


test("truncated control after genuine source release cannot authorize cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-inventory-control-eof-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nprocess.exit(75);\n`, { mode: 0o700 });
    await writeFile(join(tools, "python3"), `#!${python}\nimport runpy;runpy.run_path(${JSON.stringify(resolve(import.meta.dir, "fixtures/retained-inventory-os.py"))},run_name='__main__')\n`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"), "--port", "2222", "--identity", join(root, "key"), "--known-hosts", join(root, "hosts"), "--nonce", nonce], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, INVENTORY_SCENARIO: "helper-truncated-after-release" } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(await Bun.file(join(root, "source-release-completed.json")).json()).toEqual({ queries: 3, actualSshChildReaped: true, sourceExitCode: 0 });
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", error: { message: expect.stringContaining("control output was incomplete") }, transport: { cleanupConfirmed: false } });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
