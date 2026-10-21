import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const nonce = "12345678-1234-1234-1234-123456789abc";
const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts");
test("readiness may obtain verified boot after a clean locally expired observation without changing the failed observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-readiness-expired-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const ready = JSON.stringify({ status: "done", extended_status: "done", errors: [], recoverable_errors: {} }) + "\nFLEUR_OWNED_GUEST_NONCE=" + nonce + "\n";
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const calls=await Bun.file(root+'/calls').exists()?Number(await Bun.file(root+'/calls').text())+1:1;await Bun.write(root+'/calls',String(calls));if(calls===1){process.on('SIGTERM',async()=>{await Bun.write(root+'/term-received','TERM');process.exit(255);});setTimeout(()=>process.exit(255),8000);}else process.stdout.write(${JSON.stringify(ready)});\n`, { mode: 0o700 });
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
    const entry = `const {waitForGuestBoot}=await import(${JSON.stringify(script)});console.log(JSON.stringify(await waitForGuestBoot(${JSON.stringify(target)},{deadline:performance.now()+5000,attemptTimeoutMs:1000})));`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    expect(await Bun.file(join(root, "term-received")).text()).toBe("TERM");
    expect(JSON.parse(stdout)).toMatchObject({ formatVersion: 1, scope: "fresh-linux-boot-readiness", ok: true, state: "ready", lastBootObservation: { ok: true, state: "ready", cloudInitComplete: true, nonceMatched: true } });
    expect(await Bun.file(join(root, "calls")).text()).toBe("2");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);


async function readinessFixture(behavior: string) {
  const root = await mkdtemp(join(tmpdir(), "fleur-readiness-boundary-"));
  const tools = join(root, "tools"); await mkdir(tools);
  await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const calls=await Bun.file(root+'/calls').exists()?Number(await Bun.file(root+'/calls').text())+1:1;await Bun.write(root+'/calls',String(calls));${behavior}\n`, { mode: 0o700 });
  const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
  return {
    root,
    async run(totalMs: number, attemptMs = 1000, vmExitMs?: number) {
      const lifecycle = vmExitMs === undefined ? "const signal=undefined;" : `const stop=new AbortController();const vm=Bun.spawn([process.execPath,'--eval',${JSON.stringify(`setTimeout(()=>process.exit(0),${vmExitMs})`)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});vm.exited.then(()=>stop.abort());const signal=stop.signal;`;
      const entry = `const {waitForGuestBoot}=await import(${JSON.stringify(script)});${lifecycle}console.log(JSON.stringify(await waitForGuestBoot(${JSON.stringify(target)},{deadline:performance.now()+${totalMs},attemptTimeoutMs:${attemptMs},signal})));`;
      const started = performance.now();
      const preload = await Bun.file(join(root, "denied.ts")).exists() ? ["--preload", join(root, "denied.ts")] : [];
      const child = Bun.spawn([process.execPath, ...preload, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { observed: JSON.parse(stdout), stdout, stderr, exit, elapsedMs: performance.now() - started };
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("an immediate empty unknown255 remains a single terminal readiness failure", async () => {
  const fixture = await readinessFixture("process.exit(255);");
  try {
    const result = await fixture.run(5000);
    expect(result.exit, result.stderr + result.stdout).toBe(0);
    expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "SSH_FAILED" }, lastBootObservation: { state: "failed", transport: { deadlineFired: false, terminationRequested: false, exitCode: 255, cleanupConfirmed: true } } });
    expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("1");
  } finally { await fixture.close(); }
}, 10000);

for (const stream of ["stdout", "stderr"] as const) {
  test(`a locally expired255 with ${stream} evidence is not retried`, async () => {
    const fixture = await readinessFixture(`process.on('SIGTERM',()=>{process.${stream}.write('Host key verification failed.\\n');process.exit(255);});setTimeout(()=>process.exit(255),8000);`);
    try {
      const result = await fixture.run(5000);
      expect(result.exit, result.stderr + result.stdout).toBe(0);
      expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "SSH_FAILED" }, lastBootObservation: { state: "failed", transport: { deadlineFired: true, cleanupConfirmed: true } } });
      expect(result.observed.lastBootObservation.transport[stream + "Bytes"]).toBeGreaterThan(0);
      expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("1");
    } finally { await fixture.close(); }
  }, 10000);
}

test("repeated clean local expiries consume the original absolute total budget", async () => {
  const fixture = await readinessFixture("process.on('SIGTERM',()=>process.exit(255));setTimeout(()=>process.exit(255),8000);");
  try {
    const result = await fixture.run(4500);
    expect(result.exit, result.stderr + result.stdout).toBe(0);
    expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_TIMEOUT" }, lastBootObservation: { state: "failed", transport: { deadlineFired: true, exitCode: 255, cleanupConfirmed: true } } });
    expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("2");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(4500);
    expect(result.elapsedMs).toBeLessThan(5500);
  } finally { await fixture.close(); }
}, 10000);

test("owned VM exit aborts the active observation and awaits its transport retirement", async () => {
  const fixture = await readinessFixture("process.on('SIGTERM',()=>process.exit(255));setTimeout(()=>process.exit(255),8000);");
  try {
    const result = await fixture.run(5000, 4000, 1500);
    expect(result.exit, result.stderr + result.stdout).toBe(0);
    expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_FAILED" }, lastBootObservation: { transport: { deadlineFired: false, terminationRequested: true, cleanupConfirmed: true } } });
    expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("1");
    expect(result.elapsedMs).toBeLessThan(3000);
  } finally { await fixture.close(); }
}, 10000);


test("unconfirmed local expiry cleanup is terminal and never authorizes another observation", async () => {
  const fixture = await readinessFixture("setTimeout(()=>process.exit(255),8000);");
  try {
    await writeFile(join(fixture.root, "denied.ts"), "const original=process.kill.bind(process);process.kill=((pid,signal)=>{if(pid<0&&signal!==0)throw Object.assign(new Error('Owned fixture EPERM'),{code:'EPERM'});return original(pid,signal);});\n");
    const result = await fixture.run(6500);
    expect(result.exit, result.stderr + result.stdout).toBe(0);
    expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_OBSERVATION_FAILED" }, lastBootObservation: { state: "failed", transport: { deadlineFired: true, terminationRequested: true, cleanupConfirmed: false } } });
    expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("1");
    expect(result.elapsedMs).toBeLessThan(5000);
  } finally { await fixture.close(); }
}, 10000);
