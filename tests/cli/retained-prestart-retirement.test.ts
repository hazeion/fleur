import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("a cancelled observation awaits its actual idle relay without inventing an SSH exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-relay-prestart-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    // Only the external executable is delayed. The real source must receive
    // EOF without a start command, then await the same helper's actual exit.
    await writeFile(join(tools, "python3"), `#!${python}
import os,runpy,sys,time
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT'])
time.sleep(0.6)
try:
 runpy.run_path(sys.argv[2],run_name='__main__')
except SystemExit as result:
 (root/'source-exit').write_text(str(result.code))
 time.sleep(0.3)
 (root/'helper-ending').write_text('actual helper exiting')
 raise
`, { mode: 0o700 });
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-started','started');process.exit(255);\n`, { mode: 0o700 });
    const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts");
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce: "12345678-1234-1234-1234-123456789abc" };
    const entry = `const {observeBoot}=await import(${JSON.stringify(script)});console.log(JSON.stringify(await observeBoot(${JSON.stringify(target)},100)));`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const sourceExitedAtReceipt = await Bun.file(join(root, "source-exit")).exists();
    const helperEndingAtReceipt = await Bun.file(join(root, "helper-ending")).exists();
    // Retire the bounded fixture even on RED, without changing the receipt.
    const backupEnd = performance.now() + 3000;
    while (!await Bun.file(join(root, "helper-ending")).exists() && performance.now() < backupEnd) await Bun.sleep(10);
    expect(exit, stderr + stdout).toBe(0);
    expect(stderr).toBe("");
    expect(await Bun.file(join(root, "source-exit")).text()).toBe("0");
    expect(await Bun.file(join(root, "ssh-started")).exists()).toBe(false);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", transport: { deadlineFired: true, terminationRequested: true, exitCode: null, signal: null, cleanupConfirmed: true } });
    expect(sourceExitedAtReceipt).toBe(true);
    expect(helperEndingAtReceipt).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);

for (const scenario of ["nonzero", "truncated", "unexpected-record"]) {
  test(`a cancelled idle relay cannot confirm cleanup with ${scenario} completion`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-relay-prestart-refusal-"));
    try {
      const tools = join(root, "tools"); await mkdir(tools);
      const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
      await writeFile(join(tools, "python3"), `#!${python}
import os,runpy,sys,time
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT'])
time.sleep(0.6)
try:
 runpy.run_path(sys.argv[2],run_name='__main__')
except SystemExit as result:
 (root/'source-exit').write_text(str(result.code))
 scenario=os.environ['IDLE_SCENARIO']
 if scenario=='nonzero':sys.exit(23)
 if scenario=='truncated':os.write(3,b'{')
 if scenario=='unexpected-record':os.write(3,b'{"kind":"pipes"}\\n')
 raise
`, { mode: 0o700 });
      await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-started','started');process.exit(255);\n`, { mode: 0o700 });
      const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts");
      const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce: "12345678-1234-1234-1234-123456789abc" };
      const entry = `const {observeBoot}=await import(${JSON.stringify(script)});console.log(JSON.stringify(await observeBoot(${JSON.stringify(target)},100)));`;
      const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, IDLE_SCENARIO: scenario } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(0);
      expect(stderr).toBe("");
      expect(await Bun.file(join(root, "source-exit")).text()).toBe("0");
      expect(await Bun.file(join(root, "ssh-started")).exists()).toBe(false);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, state: "failed", transport: { deadlineFired: true, terminationRequested: true, exitCode: null, cleanupConfirmed: false } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10000);
}

test("an idle helper's late exit cannot extend the original retirement budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-relay-prestart-budget-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    await writeFile(join(tools, "python3"), `#!${python}
import os,runpy,sys,time
from pathlib import Path
root=Path(os.environ['FIXTURE_ROOT'])
time.sleep(0.6)
try:
 runpy.run_path(sys.argv[2],run_name='__main__')
except SystemExit as result:
 (root/'source-exit').write_text(str(result.code))
 time.sleep(3.2)
 (root/'helper-ending').write_text('late actual helper exit')
 raise
`, { mode: 0o700 });
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/ssh-started','started');process.exit(255);\n`, { mode: 0o700 });
    const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts");
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce: "12345678-1234-1234-1234-123456789abc" };
    const entry = `const {observeBoot}=await import(${JSON.stringify(script)});console.log(JSON.stringify(await observeBoot(${JSON.stringify(target)},100)));`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const helperEndingAtReceipt = await Bun.file(join(root, "helper-ending")).exists();
    const backupEnd = performance.now() + 3000;
    while (!await Bun.file(join(root, "helper-ending")).exists() && performance.now() < backupEnd) await Bun.sleep(10);
    expect(exit, stderr + stdout).toBe(0);
    expect(stderr).toBe("");
    expect(await Bun.file(join(root, "source-exit")).text()).toBe("0");
    expect(await Bun.file(join(root, "ssh-started")).exists()).toBe(false);
    expect(await Bun.file(join(root, "helper-ending")).text()).toBe("late actual helper exit");
    expect(helperEndingAtReceipt).toBe(false);
    const observed = JSON.parse(stdout);
    expect(observed).toMatchObject({ ok: false, state: "failed", transport: { deadlineFired: true, terminationRequested: true, exitCode: null, cleanupConfirmed: false } });
    expect(observed.transport.elapsedMs).toBeGreaterThanOrEqual(3000);
    expect(observed.transport.elapsedMs).toBeLessThan(3500);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
