import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { debianDependencyProfile } from "./fixtures/apt-debian-dependencies.ts";

// Run the exact inline diagnostic program. Only OS/filesystem and source-owned
// host modules are controlled; this fixture supplies no product setup outcome.
test("read-only recovery observation preserves unknown locks and provenance refusal as diagnostic facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-recovery-observation-"));
  try {
    const extract = Bun.spawnSync(["python3", "-I", "-c", "import ast,json,sys; t=ast.parse(open(sys.argv[1]).read()); v=[ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='RECOVERY_HOST_OBSERVATION' for x in n.targets)]; assert len(v)==1; print(json.dumps(v[0]))", resolve(import.meta.dir, "../../scripts/debian-interruption-guest.py")]);
    expect(extract.exitCode, extract.stderr.toString()).toBe(0);
    const program = JSON.parse(extract.stdout.toString()) as string;
    const packageRoot = join(root, "lab/package"); const setup = join(packageRoot, "src/setup");
    await mkdir(setup, { recursive: true });
    const binding = { nonce: "12345678-1234-4234-8234-123456789abc", bootId: "87654321-4321-4321-8321-cba987654321", uid: process.getuid!(), manifestSha256: "b".repeat(64) };
    const identity = { system: "linux", distribution: "debian", release: "13", architecture: "x64", translated: false, bootId: binding.bootId };
    const health = Object.entries({ ...debianDependencyProfile.packages, ...Object.fromEntries(Object.entries(debianDependencyProfile.distroDependencies.artifacts).map(([name, artifact]) => [name, artifact.version])) }).map(([name, version]) => `${name === "libjansson4" || name === "libnftables1" ? name + ":amd64" : name}\t${version}\tinstalled\tok\n`).join("");
    await writeFile(join(setup, "host.ts"), `export const productionHost=()=>({host:async()=>(${JSON.stringify(identity)}),aptPackageLocks:async(budget)=>{globalThis.__observationCalls.push({kind:'locks',budget});return 'unknown'},run:async(args,budget,context)=>{globalThis.__observationCalls.push({kind:'health',args,budget,context});return {status:'completed',exitCode:0,stdout:${JSON.stringify(health)},stderr:''}}});`);
    await writeFile(join(setup, "native.ts"), `export const nativeInstallProfiles=[${JSON.stringify(debianDependencyProfile)}];export const selectNativeProfile=(identity,profiles)=>profiles[0];`);
    await writeFile(join(setup, "apt-service.ts"), `export const aptServicePolicy=(profile)=>({provenance:async(host,remaining)=>{globalThis.__observationCalls.push({kind:'provenance',budget:remaining()});throw Error('Controlled unit provenance refusal')}});`);
    // Exercise actual parsing/canonicalization over the protocol health bytes.
    for (const name of ["apt-health.ts", "apt-dependencies.ts"]) await copyFile(resolve(import.meta.dir, "../../src/setup", name), join(setup, name));
    const kernel = "1: FLOCK  ADVISORY  WRITE 1234 00:01:99 0 EOF\n";
    const preload = join(root, "controlled-host.ts");
    await writeFile(preload, `import {mock} from 'bun:test';import {writeFileSync} from 'node:fs';
const actual=await import('node:fs/promises');globalThis.__observationCalls=[];let kernelClosed=false;
Object.defineProperty(process,'platform',{value:'linux'});Object.defineProperty(process,'arch',{value:'x64'});
const paths=['/var/lib/dpkg/lock','/var/lib/dpkg/lock-frontend','/var/lib/apt/lists/lock','/var/cache/apt/archives/lock','/','/var','/var/cache','/var/cache/apt','/var/cache/apt/archives'];
mock.module('node:fs/promises',()=>({...actual,lstat:async(path,options)=>{if(!paths.includes(path))throw Error('Unexpected diagnostic path');globalThis.__observationCalls.push({kind:'lstat',path});if(path===paths[3])throw Object.assign(Error('absent'),{code:'ENOENT'});const directory=paths.indexOf(path)>=4;return {isFile:()=>!directory,isDirectory:()=>directory,isSymbolicLink:()=>false,dev:1n,ino:BigInt(2+paths.indexOf(path)),uid:0n,gid:0n,mode:directory?16877n:33184n,nlink:directory?2n:1n}},open:async(path,flags)=>{if(path!=='/proc/locks'||flags&3)throw Error('Diagnostic attempted an unexpected or writable open');globalThis.__observationCalls.push({kind:'kernel-open',path,flags});const body=Buffer.from(${JSON.stringify(kernel)});return {stat:async()=>({isFile:()=>true,uid:0}),read:async(buffer,offset,length,position)=>{const n=Math.min(length,Math.max(0,body.length-position));body.copy(buffer,offset,position,position+n);return {bytesRead:n}},close:async()=>{kernelClosed=true}}}}));
process.on('exit',()=>writeFileSync(${JSON.stringify(join(root, "calls.json"))},JSON.stringify({calls:globalThis.__observationCalls,kernelClosed})));
`);
    const child = Bun.spawn([process.execPath, "--preload", preload, "--eval", program, "--", packageRoot, "2000", JSON.stringify(binding)], { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 5000, env: { ...process.env, HOME: root } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0); expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ formatVersion: 1, scope: "debian-recovery-readonly-host-observation", readOnly: true, binding, packageLockObservation: "unknown", health: { status: "completed", exitCode: 0, parsed: true, rows: 8 }, serviceProvenance: { verified: false, error: "Controlled unit provenance refusal" } });
    expect(result.lockFiles["/var/cache/apt/archives/lock"]).toEqual({ errorCode: "ENOENT" });
    const expectedPaths = ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock", "/", "/var", "/var/cache", "/var/cache/apt", "/var/cache/apt/archives"];
    expect(Object.keys(result.lockFiles).sort()).toEqual([...expectedPaths].sort());
    for (const path of expectedPaths.slice(4)) expect(result.lockFiles[path]).toMatchObject({ directory: true, regular: false, uid: "0", gid: "0", mode: "16877", nlink: "2" });
    expect(result.lockFiles[expectedPaths[0]!]).toMatchObject({ directory: false, regular: true, uid: "0", mode: "33184", nlink: "1" });
    expect(result.kernelLocks).toEqual({ bytes: Buffer.byteLength(kernel), sha256: Bun.CryptoHasher.hash("sha256", kernel, "hex"), prefix: kernel, prefixTruncated: false });
    expect(Object.keys(result.health.expectedPackages)).toHaveLength(8);
    for (const state of Object.values(result.health.expectedPackages)) expect(state).toMatchObject({ status: "installed" });
    expect(result.ok).toBeUndefined(); expect(result.assistedRecoveryQualified).toBeUndefined();
    const witness = JSON.parse(await readFile(join(root, "calls.json"), "utf8"));
    expect(witness.kernelClosed).toBe(true);
    expect(witness.calls.filter((call: { kind: string }) => call.kind === "health")).toHaveLength(1);
    expect(witness.calls.filter((call: { kind: string }) => call.kind === "provenance")).toHaveLength(1);
    expect(witness.calls.filter((call: { kind: string }) => call.kind === "lstat").map((call: { path: string }) => call.path).sort()).toEqual([...expectedPaths].sort());
    for (const call of witness.calls.filter((call: { budget?: number }) => call.budget !== undefined)) expect(call.budget).toBeGreaterThan(0);
    expect(witness.calls.find((call: { kind: string }) => call.kind === "health").context).toEqual({ outputLimitBytes: 2097152 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10000);
