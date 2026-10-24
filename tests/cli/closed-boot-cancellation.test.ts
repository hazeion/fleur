import { expect, test } from "bun:test";
import { resolve } from "node:path";

// A controlled retained-child boundary exercises cancellation/cleanup states
// that an actual completed SSH fixture cannot deterministically manufacture.
for (const scenario of ["control", "cancelled", "cleanup-unknown", "signalled", "expired"] as const) {
  test(`the exact closed boot response handles retained-child state ${scenario}`, async () => {
    const source = `import {mock} from 'bun:test';import {Readable} from 'node:stream';
const scenario=${JSON.stringify(scenario)};let requested=false;
const child={stdout:Readable.from([]),stderr:Readable.from(['Connection closed by 127.0.0.1 port 2222\\r\\n']),finished:scenario==='expired'?new Promise(resolve=>setTimeout(()=>resolve(255),30)):Promise.resolve(255),signalFailed:new Promise(()=>{}),exitCode:255,signal:scenario==='signalled'?'SIGTERM':null,get terminationRequested(){return requested},requestTermination(){requested=true},cleanup:async()=>{if(scenario==='cleanup-unknown')throw Error('Controlled SSH cleanup uncertainty')}};
mock.module(${JSON.stringify(resolve(import.meta.dir, "../../scripts/retained-ssh.ts"))},()=>({startRetainedSsh:()=>child}));
const {observeBoot}=await import(${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts"))});const controller=new AbortController();if(scenario==='cancelled')controller.abort();
console.log(JSON.stringify(await observeBoot({port:2222,identity:'fixed',knownHosts:'fixed',nonce:'12345678-1234-1234-1234-123456789abc'},scenario==='expired'?1:1000,controller.signal)));
`;
    const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0); expect(stderr).toBe("");
    const observed = JSON.parse(stdout);
    expect(observed.ok).toBe(false); expect(observed.state).toBe(scenario === "control" ? "pending" : "failed");
    expect(observed.cloudInitComplete).toBeUndefined(); expect(observed.nonceMatched).toBeUndefined();
    if (scenario === "cleanup-unknown") expect(observed.transport.cleanupConfirmed).toBe(false);
    if (scenario === "cancelled") expect(observed.transport.terminationRequested).toBe(true);
    if (scenario === "expired") expect(observed.transport.deadlineFired).toBe(true);
  });
}
