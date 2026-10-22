import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts");
const relayScript = resolve(import.meta.dir, "../../scripts/retained-ssh.py");
const nonce = "12345678-1234-1234-1234-123456789abc";

test("boot work exhausted during actual transport setup cannot start SSH afterward", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-boot-setup-deadline-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(join(tools, "ssh"), `#!/bin/sh\nprintf started > "$FIXTURE_ROOT/ssh-started"\nexec ${quote(process.execPath)} --eval 'setTimeout(()=>process.exit(255),8000)'\n`, { mode: 0o700 });
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
    const entry = `
import {mock} from 'bun:test';
import * as actual from 'node:child_process';
const originalSpawn=actual.spawn;
const relays=[];
mock.module('node:child_process',()=>({...actual,spawn:function(...args){
  const child=originalSpawn.apply(this,args);
  if(args[0]==='python3'&&args[1]?.[1]===${JSON.stringify(relayScript)}){
    const event={pid:child.pid,closed:false,code:null,signal:null,blockedMs:0};relays.push(event);
    child.once('close',(code,signal)=>{event.closed=true;event.code=code;event.signal=signal;});
    const before=performance.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);event.blockedMs=performance.now()-before;
  }
  return child;
}}));
const {observeBoot}=await import(${JSON.stringify(script)});
const observed=await observeBoot(${JSON.stringify(target)},300);
console.log(JSON.stringify({observed,relays}));
`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Preserve the public outcome and actual helper close before optional markers.
    console.info(stdout); if (stderr) console.error(stderr);
    expect(exit, stderr + stdout).toBe(0);
    const receipt = JSON.parse(stdout);
    expect(receipt.relays.length).toBe(1);
    expect(receipt.relays[0].pid).toBeGreaterThan(0);
    expect(receipt.relays[0].blockedMs).toBeGreaterThanOrEqual(2000);
    expect(receipt.relays[0]).toMatchObject({ closed: true, code: 0, signal: null });
    expect(receipt.observed).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_OBSERVATION_FAILED", message: "SSH session start was cancelled" }, transport: { timeoutMs: 300, deadlineFired: true, terminationRequested: true, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, cleanupConfirmed: true } });
    expect(receipt.observed.transport.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(await Bun.file(join(root, "ssh-started")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 12000);

test("boot watchdog grants only the allowance remaining after actual transport setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-boot-setup-deadline-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await writeFile(join(tools, "ssh"), `#!/bin/sh\nprintf started > "$FIXTURE_ROOT/ssh-started"\nexec ${quote(process.execPath)} --eval 'setTimeout(()=>Bun.write(process.env.FIXTURE_ROOT+"/late-work","late"),2000);setTimeout(()=>process.exit(255),8000)'\n`, { mode: 0o700 });
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
    const entry = `
import {mock} from 'bun:test';
import * as actual from 'node:child_process';
const originalSpawn=actual.spawn;
const relays=[];
mock.module('node:child_process',()=>({...actual,spawn:function(...args){
  const child=originalSpawn.apply(this,args);
  if(args[0]==='python3'&&args[1]?.[1]===${JSON.stringify(relayScript)}){
    const event={pid:child.pid,closed:false,code:null,signal:null,blockedMs:0};relays.push(event);
    child.once('close',(code,signal)=>{event.closed=true;event.code=code;event.signal=signal;});
    const before=performance.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);event.blockedMs=performance.now()-before;
  }
  return child;
}}));
const {observeBoot}=await import(${JSON.stringify(script)});
const observed=await observeBoot(${JSON.stringify(target)},3500);
console.log(JSON.stringify({observed,relays}));
`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Preserve the public outcome and actual helper close before optional markers.
    console.info(stdout); if (stderr) console.error(stderr);
    expect(exit, stderr + stdout).toBe(0);
    const receipt = JSON.parse(stdout);
    expect(receipt.relays.length).toBe(1);
    expect(receipt.relays[0].pid).toBeGreaterThan(0);
    expect(receipt.relays[0].blockedMs).toBeGreaterThanOrEqual(2000);
    expect(receipt.relays[0]).toMatchObject({ closed: true, code: 0, signal: null });
    expect(receipt.observed).toMatchObject({ ok: false, state: "failed", error: { code: "SSH_FAILED" }, transport: { timeoutMs: 3500, deadlineFired: true, terminationRequested: true, exitCode: 143, signal: "SIGTERM", stdoutBytes: 0, stderrBytes: 0, cleanupConfirmed: true } });
    expect(receipt.observed.transport.elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(await Bun.file(join(root, "ssh-started")).exists()).toBe(true);
    expect(await Bun.file(join(root, "late-work")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 12000);
