import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const payload = [0, 255, 13, 10, 128, 1, 42];
async function observe(scenario: string) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-artifact-output-"));
  try {
    const bin = join(directory, "bin"); await mkdir(bin);
    const witness = join(directory, "curl-executed");
    await writeFile(join(bin, "curl"), `#!${process.execPath}\nimport {writeSync} from 'node:fs';await Bun.write(${JSON.stringify(witness)},String(process.pid));writeSync(1,new Uint8Array(${JSON.stringify(payload)}));writeSync(2,'owned artifact stderr');${scenario === 'timeout' ? 'await Bun.sleep(5000);' : ''}\n`, { mode: 0o700 });
    const entry = join(directory, "observe.ts");
    await writeFile(entry, `import {open,chmod,link,readFile} from 'node:fs/promises';
import {productionHost} from ${JSON.stringify(resolve(import.meta.dir, "../../src/setup/host.ts"))};
const path=${JSON.stringify(join(directory, "artifact"))};const file=await open(path,'wx',0o600);const scenario=process.argv[2];
const output={descriptor:file.fd,maxBytes:${payload.length}};
const args=['curl','--disable','--fail','--proto','=https','--tlsv1.2','--max-redirs','0','--max-filesize',String(output.maxBytes),'--output','-','https://deb.debian.org/debian/pool/main/n/nftables/nftables_1.1.3-1_amd64.deb'];
if(scenario==='generic-command')args[0]='/bin/echo';
if(scenario==='named-output')args[11]=path;
if(scenario==='curl-config')args[1]='--fail';
if(scenario==='foreign-url')args[12]='https://foreign.invalid/payload';
if(scenario==='standard-descriptor')output.descriptor=1;
if(scenario==='mode')await chmod(path,0o644);
if(scenario==='hardlink')await link(path,path+'.foreign');
if(scenario==='nonempty')await file.writeFile('preserved sentinel');
if(scenario==='oversize')output.maxBytes=268435457;
if(scenario==='byte-limit')args[9]='99';
if(scenario==='unknown-field')Object.assign(output,{path});
if(scenario==='closed-descriptor')await file.close();
try{const result=await productionHost().run(args,scenario==='timeout'?1000:5000,{cwd:${JSON.stringify(directory)},artifactOutput:output});
let retired=true;if(scenario==='timeout'){const pid=Number(await Bun.file(${JSON.stringify(witness)}).text());retired=false;for(let i=0;i<150;i++){try{process.kill(pid,0);}catch{retired=true;break;}await Bun.sleep(10);}}
console.log(JSON.stringify({retired,result,bytes:[...await readFile(path)],executed:await Bun.file(${JSON.stringify(witness)}).exists()}));}
finally{if(scenario!=='closed-descriptor')await file.close();}
`);
    const child = Bun.spawn([process.execPath, entry, scenario], { env: { ...process.env, PATH: bin + ":/usr/bin:/bin" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 8000, killSignal: "SIGKILL" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    return JSON.parse(stdout) as { result: { status: string; exitCode: number; stdout: string; stderr: string }; bytes: number[]; executed: boolean; retired: boolean };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
test("the actual host boundary directs binary artifact output into the held descriptor", async () => {
  const observed = await observe("valid");
  expect(observed.result).toEqual({ status: "completed", exitCode: 0, stdout: "", stderr: "owned artifact stderr" });
  expect(observed.bytes).toEqual(payload);
  expect(observed.executed).toBe(true);
});
for (const scenario of ["generic-command", "named-output", "curl-config", "foreign-url", "standard-descriptor", "mode", "hardlink", "nonempty", "oversize", "byte-limit", "unknown-field", "closed-descriptor"]) {
  test(`the private artifact descriptor cannot become an arbitrary command or output capability: ${scenario}`, async () => {
    const observed = await observe(scenario);
    expect(observed.result).toMatchObject({ status: "completed", exitCode: 126, stdout: "" });
    expect(observed.executed).toBe(false);
    expect(observed.bytes).toEqual(scenario === "nonempty" ? [...Buffer.from("preserved sentinel")] : []);
  });
}

test("an actual inherited artifact output timeout retains its sink and retires the owned child", async () => {
  const observed = await observe("timeout");
  expect(observed.result).toMatchObject({ status: "timeout", stdout: "", stderr: "" });
  expect(observed.executed).toBe(true);
  expect(observed.bytes).toEqual(payload);
  expect(observed.retired).toBe(true);
});
