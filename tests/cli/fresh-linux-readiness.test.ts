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
    const entry = `const {waitForGuestBoot}=await import(${JSON.stringify(script)});console.log(JSON.stringify(await waitForGuestBoot(${JSON.stringify(target)},{deadline:performance.now()+11000,attemptTimeoutMs:4000})));`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 14000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    expect(await Bun.file(join(root, "term-received")).text()).toBe("TERM");
    expect(JSON.parse(stdout)).toMatchObject({ formatVersion: 1, scope: "fresh-linux-boot-readiness", ok: true, state: "ready", lastBootObservation: { ok: true, state: "ready", cloudInitComplete: true, nonceMatched: true } });
    expect(await Bun.file(join(root, "calls")).text()).toBe("2");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 16000);


async function readinessFixture(behavior: string) {
  const root = await mkdtemp(join(tmpdir(), "fleur-readiness-boundary-"));
  const tools = join(root, "tools"); await mkdir(tools);
  await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT;const calls=await Bun.file(root+'/calls').exists()?Number(await Bun.file(root+'/calls').text())+1:1;await Bun.write(root+'/calls',String(calls));${behavior}\n`, { mode: 0o700 });
  const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
  return {
    root,
    async run(totalMs: number, attemptMs = 4000, vmExitMs?: number) {
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
      const result = await fixture.run(8000);
      expect(result.exit, result.stderr + result.stdout).toBe(0);
      expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "SSH_FAILED" }, lastBootObservation: { state: "failed", transport: { deadlineFired: true, cleanupConfirmed: true } } });
      expect(result.observed.lastBootObservation.transport[stream + "Bytes"]).toBeGreaterThan(0);
      expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("1");
    } finally { await fixture.close(); }
  }, 10000);
}

function relayWitnessPrelude(): string {
  return `import {mock} from 'bun:test';
import * as actualChildProcess from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
const originalSpawn=actualChildProcess.spawn;const relays=[];
mock.module('node:child_process',()=>({...actualChildProcess,spawn:function(...args){
  const startedAt=originalNow();
  const child=originalSpawn.apply(this,args);
  if(args[0]==='python3'&&Array.isArray(args[1])&&args[1].length===2&&args[1][0]==='-I'&&args[1][1]===${JSON.stringify(resolve(import.meta.dir, "../../scripts/retained-ssh.py"))}){
    const event={pid:child.pid,startedAt,closed:false,code:null,signal:null,sshPids:[],statuses:[]};
    relays.push(event);
    let pending='';
    const control=child.stdio[3];
    const iterate=control[Symbol.asyncIterator].bind(control);
    // Observe only chunks already requested by the production consumer.
    // Forward the same chunks once; never start a second flowing reader.
    control[Symbol.asyncIterator]=async function*(){
      for await(const chunk of {[Symbol.asyncIterator]:iterate}){
        pending+=chunk.toString();
        let end;
        while((end=pending.indexOf('\\n'))>=0){
          const record=JSON.parse(pending.slice(0,end));
          pending=pending.slice(end+1);
          if(record.kind==='pid')event.sshPids.push(record.pid);
          if(record.kind==='status')event.statuses.push({code:record.code,signal:record.signal});
        }
        yield chunk;
      }
    };
    child.once('close',(code,signal)=>{event.closed=true;event.code=code;event.signal=signal;});
  }
  return child;
}}));
`;
}

async function witnessedExpiryReadiness(fractional: boolean) {
  const root = await mkdtemp(join(tmpdir(), "fleur-readiness-witness-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const body = "import {appendFileSync} from 'node:fs';const receipt=(kind)=>appendFileSync(process.env.FIXTURE_ROOT+'/ssh-events',JSON.stringify({kind,pid:process.pid,ppid:process.ppid})+'\\n');process.on('SIGTERM',()=>{receipt('term');process.exit(255);});setTimeout(()=>process.exit(255),8000);";
    // Record the actual SSH executable's PID before Bun startup. exec keeps the
    // same PID, so a shortened final attempt still has a truthful launch witness.
    await writeFile(join(tools, "ssh"), `#!/bin/sh
root="$FIXTURE_ROOT"
calls=0
if [ -f "$root/calls" ]; then IFS= read -r calls < "$root/calls" || :; fi
calls=$((calls+1))
printf '%s' "$calls" > "$root/calls"
printf '{"kind":"launch","pid":%s,"ppid":%s}\\n' "$$" "$PPID" >> "$root/ssh-events"
exec ${quoteShell(process.execPath)} --eval ${quoteShell(body)}
`, { mode: 0o700 });
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
    const entry = `
${relayWitnessPrelude()}
const {waitForGuestBoot}=await import(${JSON.stringify(script)});
const originalNow=performance.now.bind(performance);const originalTimer=globalThis.setTimeout;
const startNow=originalNow();const deadline=startNow+11000;
let finalWake=false;let edgeReads=0;let zeroYield=false;let selectedDelay=null;let edgeArmed=false;
const sshEvents=()=>existsSync(${JSON.stringify(join(root, "ssh-events"))})?readFileSync(${JSON.stringify(join(root, "ssh-events"))},'utf8').trim().split('\\n').map(JSON.parse):[];
if(${fractional}){
Object.defineProperty(performance,'now',{configurable:true,value:()=>{if(!edgeArmed)return originalNow();edgeReads++;if(edgeReads<=2)return deadline-0.5;if(edgeReads===3){if(!zeroYield)throw new Error('Fractional edge returned without an actual zero-delay yield');return deadline;}return originalNow();}});
globalThis.setTimeout=((callback,delay,...args)=>{
const events=sshEvents();const launches=events.filter(x=>x.kind==='launch');const terms=events.filter(x=>x.kind==='term');
const complete=relays.length===1&&relays.every(x=>x.closed&&x.code===0&&x.signal===null)&&launches.length===1&&terms.length===1&&relays.every(x=>launches.filter(y=>y.ppid===x.pid).length===1);
const absent=complete&&launches.every(event=>{try{process.kill(-event.pid,0);return false;}catch(error){return error.code==='ESRCH';}});
// A ten-millisecond timer belongs to the transport's post-close inventory poll, not readiness backoff.
if(!finalWake&&absent&&delay>0&&delay<=1000&&delay!==10){return originalTimer(()=>{selectedDelay=delay;finalWake=true;edgeArmed=true;callback(...args);},delay);}
if(edgeArmed&&edgeReads===2&&delay===0)return originalTimer(()=>{zeroYield=true;callback(...args);},delay);
return originalTimer(callback,delay,...args);
});
}
const result=await waitForGuestBoot(${JSON.stringify(target)},{deadline,attemptTimeoutMs:4000});
const events=sshEvents();const actualSshPids=relays.flatMap(x=>x.sshPids);const absentGroups=actualSshPids.map(pid=>{try{process.kill(-pid,0);return false;}catch(error){return error.code==='ESRCH';}});
console.log(JSON.stringify({result,relays,events,absentGroups,deadline,finalWake,edgeReads,zeroYield,selectedDelay}));
`;
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 14000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const elapsedMs = performance.now() - started;
    // Keep actual receipts in the test log before asserting or removing fixtures.
    console.info(stdout);
    if (stderr) console.error(stderr);
    expect(exit, stderr + stdout).toBe(0);
    const observed = JSON.parse(stdout);
    const launches = observed.events.filter((event: { kind: string }) => event.kind === "launch");
    const terms = observed.events.filter((event: { kind: string }) => event.kind === "term");
    expect(launches.length).toBeGreaterThanOrEqual(fractional ? 1 : 2);
    expect(launches.length).toBeLessThanOrEqual(3);
    expect(await Bun.file(join(root, "calls")).text()).toBe(String(launches.length));
    expect(terms.length).toBeGreaterThanOrEqual(fractional ? 1 : 2);
    expect(terms.length).toBeLessThanOrEqual(launches.length);
    const actualSshPids = observed.relays.flatMap((relay: { sshPids: number[] }) => relay.sshPids);
    expect(new Set(actualSshPids).size).toBe(actualSshPids.length);
    expect(observed.absentGroups).toEqual(actualSshPids.map(() => true));
    expect(observed.relays.length).toBeGreaterThanOrEqual(launches.length);
    expect(observed.relays.length).toBeLessThanOrEqual(3);
    for (const relay of observed.relays) {
      expect(relay).toMatchObject({ closed: true, code: 0, signal: null });
      expect(Number.isFinite(relay.startedAt)).toBe(true);
      expect(relay.startedAt).toBeLessThan(observed.deadline);
      expect(relay.sshPids.length).toBeLessThanOrEqual(1);
      expect(relay.statuses).toHaveLength(relay.sshPids.length);
      for (const pid of relay.sshPids) {
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        const receipts = launches.filter((launch: { pid: number; ppid: number }) => launch.pid === pid && launch.ppid === relay.pid);
        // Only the final shortened attempt can die before its first instruction.
        if (relay !== observed.relays.at(-1)) {
          expect(receipts).toHaveLength(1);
          expect(relay.statuses).toEqual([{ code: 255, signal: null }]);
        } else expect(receipts.length).toBeLessThanOrEqual(1);
      }
    }
    for (const launch of launches) {
      expect(observed.relays.filter((relay: { pid: number }) => relay.pid === launch.ppid).length).toBe(1);
      const relay = observed.relays.find((relay: { pid: number }) => relay.pid === launch.ppid);
      expect(relay.sshPids).toEqual([launch.pid]);
      expect(terms.filter((term: { pid: number; ppid: number }) => term.pid === launch.pid && term.ppid === launch.ppid).length).toBeLessThanOrEqual(1);
    }
    for (const launch of launches.slice(0, fractional ? 1 : 2)) {
      expect(terms.filter((term: { pid: number; ppid: number }) => term.pid === launch.pid && term.ppid === launch.ppid).length).toBe(1);
    }
    for (const term of terms) {
      expect(launches.filter((launch: { pid: number; ppid: number }) => launch.pid === term.pid && launch.ppid === term.ppid).length).toBe(1);
    }
    const last = observed.result.lastBootObservation;
    expect(observed.result).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_TIMEOUT" }, lastBootObservation: { state: "failed", transport: { deadlineFired: true, terminationRequested: true, stdoutBytes: 0, stderrBytes: 0, cleanupConfirmed: true } } });
    expect(last.transport.timeoutMs).toBeGreaterThan(0);
    expect(last.transport.timeoutMs).toBeLessThanOrEqual(4000);
    expect(last.transport.elapsedMs).toBeGreaterThanOrEqual(last.transport.timeoutMs);
    const finalRelay = observed.relays.at(-1);
    const finalLaunches = launches.filter((event: { ppid: number }) => event.ppid === finalRelay.pid);
    if (last.transport.exitCode === 255) {
      expect(last.error.code).toBe("SSH_FAILED");
      expect(last.transport.signal).toBeNull();
      expect(finalRelay.sshPids).toHaveLength(1);
      expect(finalRelay.statuses).toEqual([{ code: 255, signal: null }]);
      expect(finalLaunches.length).toBe(1);
      expect(terms.filter((term: { pid: number }) => term.pid === finalLaunches[0].pid).length).toBe(1);
    } else if (last.transport.exitCode !== null) {
      // The retained parent reports the actual PID even if the shortened probe
      // dies before its shell receipt or Bun signal handler can run.
      expect(last.error.code).toBe("SSH_FAILED");
      expect(finalRelay.sshPids).toHaveLength(1);
      expect(finalRelay.statuses).toEqual([{ code: last.transport.exitCode, signal: last.transport.signal }]);
      expect(finalLaunches.length).toBeLessThanOrEqual(1);
      expect(["SIGTERM", "SIGKILL"]).toContain(last.transport.signal);
      expect(last.transport.exitCode).toBe(last.transport.signal === "SIGTERM" ? 143 : 137);
    } else {
      expect(last.transport.exitCode).toBeNull();
      expect(last.transport.signal).toBeNull();
      expect(last.error).toEqual({ code: "BOOT_OBSERVATION_FAILED", message: "SSH session start was cancelled" });
      expect(finalRelay.sshPids).toEqual([]);
      expect(finalRelay.statuses).toEqual([]);
      expect(finalLaunches.length).toBe(0);
      expect(observed.relays.length).toBe(launches.length + 1);
    }
    return { observed, elapsedMs, launches };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("repeated clean local expiries consume the original absolute total budget", async () => {
  const result = await witnessedExpiryReadiness(false);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(11000);
  expect(result.elapsedMs).toBeLessThan(12000);
}, 16000);

test("an SSH attempt retires with a retained PID even before its executable writes a launch receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-readiness-pre-witness-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    // The first fixture instruction waits beyond the unchanged four-second
    // observation budget. A real parent PID/status receipt must cover its death.
    await writeFile(join(tools, "ssh"), '#!/bin/sh\n/bin/sleep 8\nprintf launched > "$FIXTURE_ROOT/launch-receipt"\n', { mode: 0o700 });
    const target = { port: 2222, identity: join(root, "key"), knownHosts: join(root, "hosts"), nonce };
    const entry = `${relayWitnessPrelude()}
const originalNow=performance.now.bind(performance);
const {observeBoot}=await import(${JSON.stringify(script)});
const result=await observeBoot(${JSON.stringify(target)},4000);
const actualSshPids=relays.flatMap(x=>x.sshPids);
const absentGroups=actualSshPids.map(pid=>{try{process.kill(-pid,0);return false;}catch(error){return error.code==='ESRCH';}});
console.log(JSON.stringify({result,relays,actualSshPids,absentGroups,launchReceipt:existsSync(${JSON.stringify(join(root, "launch-receipt"))})}));`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, env: { ...process.env, PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.info(stdout);
    expect(exit, stderr + stdout).toBe(0);
    expect(stderr).toBe("");
    const observed = JSON.parse(stdout);
    const transport = observed.result.transport;
    expect(observed.result).toMatchObject({ ok: false, state: "failed", error: { code: "SSH_FAILED" }, transport: { timeoutMs: 4000, deadlineFired: true, terminationRequested: true, stdoutBytes: 0, stderrBytes: 0, cleanupConfirmed: true } });
    expect(["SIGTERM", "SIGKILL"]).toContain(transport.signal);
    expect(transport.exitCode).toBe(transport.signal === "SIGTERM" ? 143 : 137);
    expect(transport.elapsedMs).toBeGreaterThanOrEqual(4000);
    expect(transport.elapsedMs).toBeLessThan(7000);
    expect(observed.launchReceipt).toBe(false);
    expect(observed.relays).toHaveLength(1);
    expect(observed.relays[0]).toMatchObject({ closed: true, code: 0, signal: null });
    expect(observed.relays[0].sshPids).toHaveLength(1);
    expect(Number.isSafeInteger(observed.actualSshPids[0]) && observed.actualSshPids[0] > 0).toBe(true);
    expect(observed.relays[0].statuses).toEqual([{ code: transport.exitCode, signal: transport.signal }]);
    expect(observed.absentGroups).toEqual([true]);
  } finally { await rm(root, { recursive: true, force: true }); }
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
    await writeFile(join(fixture.root, "denied.ts"), "import {appendFileSync} from 'node:fs';const original=process.kill.bind(process);process.kill=((pid,signal)=>{if(pid<0&&signal!==0){appendFileSync(process.env.FIXTURE_ROOT+'/denied-signals',String(signal)+'\\n');throw Object.assign(new Error('Owned fixture EPERM'),{code:'EPERM'});}return original(pid,signal);});\n");
    const result = await fixture.run(10000);
    expect(result.exit, result.stderr + result.stdout).toBe(0);
    expect(result.observed).toMatchObject({ ok: false, state: "failed", error: { code: "BOOT_OBSERVATION_FAILED" }, lastBootObservation: { state: "failed", transport: { deadlineFired: true, terminationRequested: true, cleanupConfirmed: false } } });
    expect(await Bun.file(join(fixture.root, "calls")).text()).toBe("1");
    const deniedSignals = (await Bun.file(join(fixture.root, "denied-signals")).text()).trim().split("\n");
    expect(deniedSignals).toContain("SIGTERM");
    expect(deniedSignals).toContain("SIGKILL");
    expect(result.elapsedMs).toBeLessThan(8000);
  } finally { await fixture.close(); }
}, 10000);

test("a sub-millisecond remainder never starts another SSH observation or replaces completed evidence", async () => {
  const { observed, launches } = await witnessedExpiryReadiness(true);
  expect(observed.finalWake).toBe(true);
  expect(observed.zeroYield).toBe(true);
  expect(observed.edgeReads).toBe(3);
  expect(observed.selectedDelay).toBeGreaterThan(0);
  expect(observed.selectedDelay).toBeLessThanOrEqual(1000);
  expect(observed.result).toMatchObject({ ok: false, error: { code: "BOOT_TIMEOUT" }, lastBootObservation: { transport: { deadlineFired: true, exitCode: 255, cleanupConfirmed: true } } });
  expect(launches.length).toBe(1);
  expect(observed.relays.length).toBe(1);
}, 16000);

test("an initial observation still uses the available partial attempt budget", async () => {
  const fixture = await readinessFixture("process.on('SIGTERM',()=>process.exit(255));setTimeout(()=>process.exit(255),8000);");
  try {
    const result = await fixture.run(500, 1000);
    expect(result.exit, result.stderr + result.stdout).toBe(0);
    expect(result.observed).toMatchObject({ ok: false, error: { code: "BOOT_TIMEOUT" }, lastBootObservation: { transport: { deadlineFired: true, terminationRequested: true, cleanupConfirmed: true } } });
    expect(result.observed.lastBootObservation.transport.timeoutMs).toBeGreaterThan(0);
    expect(result.observed.lastBootObservation.transport.timeoutMs).toBeLessThanOrEqual(500);
    const observation = result.observed.lastBootObservation;
    const calls = Bun.file(join(fixture.root, "calls"));
    if (observation.transport.exitCode === null) {
      // Relay startup consumes the same allowance; no SSH was started.
      expect(observation.error).toEqual({ code: "BOOT_OBSERVATION_FAILED", message: "SSH session start was cancelled" });
      expect(observation.transport.signal).toBeNull();
      expect(await calls.exists()).toBe(false);
    } else if (observation.transport.signal === null) {
      expect(observation.transport.exitCode).toBe(255);
      expect(observation.error.code).toBe("SSH_FAILED");
      expect(await calls.text()).toBe("1");
    } else {
      // The reserved leader may be retired before its interpreter handler runs.
      expect(["SIGTERM", "SIGKILL"]).toContain(observation.transport.signal);
      expect(observation.transport.exitCode).toBe(observation.transport.signal === "SIGTERM" ? 143 : 137);
      expect(observation.error.code).toBe("SSH_FAILED");
      if (await calls.exists()) expect(await calls.text()).toBe("1");
    }
  } finally { await fixture.close(); }
}, 10000);
