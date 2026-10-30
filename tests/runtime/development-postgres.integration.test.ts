import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, unlink, stat } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DevelopmentPostgres, databaseLabel } from "../../src/runtime/development/postgres";

const executable = resolve(import.meta.dir, "../../src/runtime/development/postgres.ts");
const quote = (value: string) => "'"+value.replaceAll("'", "'\\''")+"'";
async function context() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fleur-pg-resource-")), directory = join(root, "private");
  await mkdir(directory, { mode: 0o700 });
  const bound = { project: root, directory, id: Bun.CryptoHasher.hash("sha256", crypto.randomUUID(), "hex") };
  return { root, bound };
}
async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error("Disposable PostgreSQL fixture control failed");
  return stdout.trim();
}
async function cleanup(root: string, bound: Awaited<ReturnType<typeof context>>["bound"]) {
  let record;
  try { record = JSON.parse(await readFile(join(bound.directory, "postgres.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { await rm(root, { recursive: true, force: true }); return; } throw error; }
  expect(record.binding).toBe(bound.id);
  if (!record.container) throw new Error("Uncertain creation retains its private ownership evidence");
  if (record.container) {
    const metadata = JSON.parse(await docker("inspect", record.container, "--format", "{{json .}}"));
    expect(metadata.Id).toBe(record.container); expect(metadata.Config.Labels[databaseLabel]).toBe(bound.id);
    expect(metadata.Mounts).toHaveLength(1); expect(metadata.Mounts[0].Name).toBe(record.volume);
    expect(metadata.State.Running).toBe(false);
    await docker("rm", record.container);
    const volume = JSON.parse(await docker("volume", "inspect", record.volume, "--format", "{{json .}}"));
    expect(volume.Name).toBe(record.volume); expect(volume.Labels[databaseLabel]).toBe(bound.id);
    await docker("volume", "rm", record.volume);
  }
  await rm(root, { recursive: true, force: true });
}

// Resource-operation component evidence, never public dev/Doctor qualification
// or a replacement for persistence through separate public CLI processes.
test("missing PostgreSQL image refuses before any persistent creation intent or Docker mutation", async () => {
  const { root, bound } = await context(), tools = join(root, "tools"), records = join(root, "requests.jsonl");
  const realDocker = Bun.which("docker"); expect(realDocker).not.toBeNull();
  try {
    await mkdir(tools);
    const shim = join(root, "docker-shim.ts");
    await writeFile(shim, `import {appendFile} from "node:fs/promises";
const args=process.argv.slice(2), op=args[0]==="--host"?args.slice(2):args;
const readOnly=op[0]==="context"&&["show","inspect"].includes(op[1]!) || op[0]==="ps" || op[0]==="inspect" || op[0]==="volume"&&["ls","inspect"].includes(op[1]!) || op[0]==="image"&&op[1]==="inspect";
if(!readOnly){await appendFile(${JSON.stringify(records)},"mutation-blocked\\n");process.exit(1);}
if(op[0]==="image"&&op[1]==="inspect"){await appendFile(${JSON.stringify(records)},"image-unavailable\\n");process.exit(1);}
const child=Bun.spawn([${JSON.stringify(realDocker)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);
`);
    await writeFile(join(tools, "docker"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shim)} "$@"\n`, { mode: 0o700 });
    const script = join(root, "operation.ts");
    await writeFile(script, `import {DevelopmentPostgres} from ${JSON.stringify(executable)};try{await DevelopmentPostgres.start(${JSON.stringify(bound)},performance.now()+30000);console.log(JSON.stringify({code:"unexpected-success"}));}catch(error){console.log(JSON.stringify({code:error instanceof Error?error.message:"unknown"}));}`);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PATH: tools+":"+process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    const requests = (await readFile(records, "utf8")).trim().split("\n");
    expect(requests.filter(value => value === "mutation-blocked")).toHaveLength(0);
    expect(JSON.parse(stdout)).toEqual({ code: "PREREQUISITE_UNAVAILABLE" });
    expect((await readdir(bound.directory)).includes("postgres.json")).toBe(false);
  } finally {
    // Every daemon mutation is refused by the shim before forwarding; only our
    // private temporary files can exist, even in the intended red failure.
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

for (let repeat = 1; repeat <= 2; repeat++) test(`PostgreSQL startup keeps credentials off argv and tool publication cannot overwrite foreign files, repeat ${repeat}`, async () => {
  const { root, bound } = await context();
  let resource: DevelopmentPostgres | undefined;
  try {
    const realDocker = Bun.which("docker"); expect(realDocker).not.toBeNull();
    const requests = join(root, "credential-observations.jsonl"), wrappers = join(root, "wrappers");
    await mkdir(wrappers);
    const shim = join(root, "docker-observer.ts");
    await writeFile(shim, `import {appendFile,stat,readFile} from "node:fs/promises";
const args=process.argv.slice(2);
if(args.includes("create")){
 const index=args.indexOf("--env-file"),path=index<0?undefined:args[index+1];
 let privateHandoff=false;
 if(path){const info=await stat(path);privateHandoff=info.isFile()&&(info.mode&0o777)===0o600&&info.uid===process.getuid?.()&&/^POSTGRES_PASSWORD=[a-f0-9-]{36}\\n$/.test(await readFile(path,"utf8"));}
 await appendFile(${JSON.stringify(requests)},JSON.stringify({passwordArgument:args.some(value=>value.startsWith("POSTGRES_PASSWORD=")),privateHandoff})+"\\n");
}
const child=Bun.spawn([${JSON.stringify(realDocker)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(await child.exited);
`);
    await writeFile(join(wrappers, "docker"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shim)} "$@"\n`, { mode: 0o700 });
    const script = join(root, "start.ts");
    await writeFile(script, `import {DevelopmentPostgres} from ${JSON.stringify(executable)};await DevelopmentPostgres.start(${JSON.stringify(bound)},performance.now()+30000);console.log("started");`);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PATH: wrappers+":"+process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    resource = await DevelopmentPostgres.read(bound) ?? undefined;
    expect(exit).toBe(0); expect(stdout.trim()).toBe("started"); expect(resource).toBeDefined();
    const observations = (await readFile(requests, "utf8")).trim().split("\n").map(value => JSON.parse(value) as {passwordArgument:boolean;privateHandoff:boolean});
    expect(observations).toEqual([{ passwordArgument: false, privateHandoff: true }]);
    expect((await readdir(bound.directory)).includes("postgres.env")).toBe(false);
    const sentinel = join(root, "foreign.txt"), tools = join(bound.directory, "pg-tools");
    await writeFile(sentinel, "foreign content"); await mkdir(tools, { mode: 0o700 });
    await symlink(sentinel, join(tools, "pg_dump"));
    await expect(resource!.tools()).rejects.toThrow("RECOVERY_REQUIRED");
    expect(await readFile(sentinel, "utf8")).toBe("foreign content");
    await unlink(join(tools, "pg_dump"));
    expect(await resource!.tools()).toBe(tools);
    const generated = await readFile(join(tools, "pg_dump"), "utf8");
    expect((await stat(join(tools, "pg_dump"))).mode & 0o7777).toBe(0o700);
    expect(await resource!.tools()).toBe(tools);
    expect(await readFile(join(tools, "pg_dump"), "utf8")).toBe(generated);
    await writeFile(join(tools, "pg_dump"), "foreign replacement");
    await expect(resource!.tools()).rejects.toThrow("RECOVERY_REQUIRED");
    expect(await readFile(join(tools, "pg_dump"), "utf8")).toBe("foreign replacement");
  } finally { await resource?.stop(); await cleanup(root, bound); }
}, 90000);
