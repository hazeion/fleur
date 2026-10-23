import { expect, test } from "bun:test";
import { copyFile, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const digest = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
async function command(args: string[], cwd: string, environment: Record<string, string>, input?: Uint8Array) {
  const child = Bun.spawn(args, { cwd, env: environment, stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000, killSignal: "SIGKILL" });
  if (input) { child.stdin?.write(input); child.stdin?.end(); }
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

async function extract(archive: string, destination: string, cwd: string, environment: Record<string, string>) {
  return command(["/usr/bin/tar", "-xf", "-", "-C", destination], cwd, environment, Bun.gunzipSync(await readFile(archive)));
}

test("internal native candidate archive preserves the ordinary release and executes the real Bun entry with pending-proof disclosure", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-internal-candidate-"));
  try {
    const bin = join(scratch, "bin"); await mkdir(bin); await symlink(process.execPath, join(bin, "bun"));
    const environment = { PATH: bin, HOME: scratch, TMPDIR: scratch };
    const productPaths = ["bin/fleur.ts", "src/setup/native.ts", "package.json"];
    const before = await Promise.all(productPaths.map((path) => readFile(join(repository, path))));
    const output = join(scratch, "artifacts");
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output], repository, environment);
    expect(built.exit, built.stderr).toBe(0);
    const report = JSON.parse(built.stdout);
    expect(report).toMatchObject({ formatVersion: 1, internalArtifact: true, catalogId: "ubuntu-24.04-amd64-docker-2026-10-19", artifactAuthentication: "authenticated", installationEvidence: "pending", runtimeSupport: "unverified" });
    for (const [index, path] of productPaths.entries()) expect(await readFile(join(repository, path))).toEqual(before[index]!);
    const ordinaryArchive = join(output, "fleur-ordinary.tgz");
    const internalArchive = join(output, "fleur-internal-native-candidate.tgz");
    expect(report.ordinary.sha256).toBe(digest(await readFile(ordinaryArchive)));
    expect(report.candidate.sha256).toBe(digest(await readFile(internalArchive)));
    const ordinary = join(scratch, "ordinary"); const internal = join(scratch, "internal");
    await mkdir(ordinary); await mkdir(internal);
    expect((await extract(ordinaryArchive, ordinary, scratch, environment)).exit).toBe(0);
    expect((await extract(internalArchive, internal, scratch, environment)).exit).toBe(0);
    const ordinaryPackage = join(ordinary, "package"); const internalPackage = join(internal, "package");
    expect(await readFile(join(ordinaryPackage, "bin/fleur.ts"))).toEqual(before[0]!);
    expect(await readFile(join(ordinaryPackage, "src/setup/native.ts"))).toEqual(before[1]!);
    expect(await Bun.file(join(ordinaryPackage, "internal-native-candidate.json")).exists()).toBe(false);
    expect(await Bun.file(join(ordinaryPackage, "bin/native-candidate-catalog.ts")).exists()).toBe(false);
    expect(await Bun.file(join(ordinaryPackage, "bin/candidate-command-observer.ts")).exists()).toBe(false);
    expect(await Bun.file(join(ordinaryPackage, "scripts/build-native-candidate.ts")).exists()).toBe(false);
    expect(await Bun.file(join(ordinaryPackage, "package.json")).json()).toMatchObject({ name: "fleur" });
    expect(await readFile(join(internalPackage, "src/setup/native.ts"))).toEqual(before[1]!);
    for (const source of report.provenance.sourceFiles as { path: string; sha256: string }[]) {
      const ordinaryBytes = await readFile(join(ordinaryPackage, source.path));
      expect(digest(ordinaryBytes)).toBe(source.sha256);
      if (source.path.startsWith("src/")) expect(await readFile(join(internalPackage, source.path))).toEqual(ordinaryBytes);
    }
    expect(await Bun.file(join(internalPackage, "package.json")).json()).toMatchObject({ name: "fleur-internal-native-candidate", private: true });
    const metadata = await Bun.file(join(internalPackage, "internal-native-candidate.json")).json();
    expect(metadata).toMatchObject({ internalArtifact: true, installationEvidence: "pending", runtimeSupport: "unverified", artifactAuthentication: "authenticated", legacyProfileAdmission: { verified: true, meaning: "internal-catalog-admission-only" } });
    const compiled = await command([process.execPath, "--eval", `const { candidateProfiles } = await import(${JSON.stringify(join(internalPackage, "bin/native-candidate-catalog.ts"))}); const profile = candidateProfiles[0]; console.log(JSON.stringify({ artifacts: profile.artifacts, frozen: Object.isFrozen(profile) && Object.isFrozen(profile.artifacts) && Object.values(profile.artifacts).every(Object.isFrozen) }));`], scratch, environment);
    expect(compiled.exit).toBe(0);
    const compiledCatalog = JSON.parse(compiled.stdout);
    expect(compiledCatalog.frozen).toBe(true);
    expect(Object.keys(compiledCatalog.artifacts).sort()).toEqual(["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin"]);
    expect(compiledCatalog.artifacts["docker-ce"]).toMatchObject({ name: "docker-ce", version: "5:29.9.1-1~ubuntu.24.04~noble", architecture: "amd64", sha256: "463a666215797c9f9ea7d0ad1751de5b2b3806a1b539a3550e16822ef34ccbfd", size: 24548040 });
    expect(metadata.provenance.ordinaryArchiveSha256).toBe(report.ordinary.sha256);
    expect(report.provenance.sourceFiles).toContainEqual({ path: "src/setup/native.ts", sha256: digest(before[1]!) });
    const normalHelp = await command([process.execPath, join(ordinaryPackage, "bin/fleur.ts"), "--json", "--help"], scratch, environment);
    expect(normalHelp.exit).toBe(0); expect(normalHelp.stderr).toBe("");
    const internalHelp = await command([process.execPath, join(internalPackage, "bin/fleur.ts"), "--json", "--help"], scratch, environment);
    expect(internalHelp.exit).toBe(0);
    expect(JSON.parse(internalHelp.stdout)).toEqual(JSON.parse(normalHelp.stdout));
    expect(internalHelp.stdout.trim().split("\n")).toHaveLength(1);
    expect(internalHelp.stderr).toContain("INTERNAL NATIVE CANDIDATE");
    expect(internalHelp.stderr).toContain("installation evidence pending; runtime support unverified");
    const doctor = await command([process.execPath, join(internalPackage, "bin/fleur.ts"), "doctor", "--json"], scratch, environment);
    expect(doctor.exit).toBe(4);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ formatVersion: 1, command: "doctor", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, truncated: false });
    expect(doctor.stderr).toContain("INTERNAL NATIVE CANDIDATE");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);

test("the candidate builder refuses dynamic catalogs and preserves an existing output directory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-guards-"));
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const script = join(repository, "scripts/build-native-candidate.ts");
    const rejected = await command([process.execPath, script, "--out", join(scratch, "dynamic"), "--catalog", "untrusted.json"], repository, environment);
    expect(rejected.exit).toBe(2);
    expect(await Bun.file(join(scratch, "dynamic", "fleur-internal-native-candidate.tgz")).exists()).toBe(false);
    const output = join(scratch, "existing"); await mkdir(output);
    await writeFile(join(output, "caller-owned.txt"), "Preserve this exact content\n");
    const collision = await command([process.execPath, script, "--out", output], repository, environment);
    expect(collision.exit).toBe(1);
    expect(await readdir(output)).toEqual(["caller-owned.txt"]);
    expect(await readFile(join(output, "caller-owned.txt"), "utf8")).toBe("Preserve this exact content\n");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("candidate provenance hashes actual copied source and unexpected entry shapes fail closed", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-source-"));
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const archive = join(scratch, "source.tgz");
    expect((await command([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], repository, environment)).exit).toBe(0);
    expect((await extract(archive, scratch, scratch, environment)).exit).toBe(0);
    const source = join(scratch, "package"); await mkdir(join(source, "scripts"));
    for (const name of ["build-native-candidate.ts", "native-candidate-ubuntu24-amd64.json", "candidate-command-observer.ts"]) await copyFile(join(repository, "scripts", name), join(source, "scripts", name));
    const script = join(source, "scripts/build-native-candidate.ts");
    const entryPath = join(source, "bin/fleur.ts"); const entry = await readFile(entryPath, "utf8");
    const inSource = await command([process.execPath, script, "--out", join(source, "src", "internal-artifacts")], source, environment);
    expect(inSource.exit).toBe(1);
    expect(await readdir(join(source, "src"))).not.toContain("internal-artifacts");
    await writeFile(entryPath, entry.replace("const handlers = [...projectCommands, ...setupCommands()];", "const handlers = [...projectCommands];"));
    const rejected = await command([process.execPath, script, "--out", join(scratch, "unexpected")], source, environment);
    expect(rejected.exit).toBe(1);
    expect(rejected.stderr).toContain("Unexpected release entry shape");
    expect(await Bun.file(join(scratch, "unexpected/fleur-internal-native-candidate.tgz")).exists()).toBe(false);
    const changed = Buffer.from(entry + "\n// Owned source snapshot differs from the original archive.\n");
    await writeFile(entryPath, changed);
    const built = await command([process.execPath, script, "--out", join(scratch, "changed")], source, environment);
    expect(built.exit, built.stderr).toBe(0);
    expect(JSON.parse(built.stdout).provenance.sourceFiles).toContainEqual({ path: "bin/fleur.ts", sha256: digest(changed) });
    expect(await readFile(entryPath)).toEqual(changed);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);

test.each(["output", "parent"] as const)("replacing the %s directory during packaging cannot publish into source or report success", async (replaced) => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-output-race-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const archive = join(scratch, "source.tgz");
    expect((await command([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], repository, environment)).exit).toBe(0);
    expect((await extract(archive, scratch, scratch, environment)).exit).toBe(0);
    const source = join(scratch, "package"); await mkdir(join(source, "scripts"));
    for (const name of ["build-native-candidate.ts", "native-candidate-ubuntu24-amd64.json", "candidate-command-observer.ts"]) await copyFile(join(repository, "scripts", name), join(source, "scripts", name));
    const parent = join(scratch, "outside"); await mkdir(parent);
    const output = join(parent, "artifacts");
    const sourceDirectory = join(source, "src");
    if (replaced === "parent") await mkdir(join(sourceDirectory, "artifacts"));
    const before = (await readdir(sourceDirectory)).sort();
    const replacedPath = replaced === "output" ? output : parent;
    const spawned = Bun.spawn([process.execPath, join(source, "scripts/build-native-candidate.ts"), "--out", output], { cwd: source, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000, killSignal: "SIGKILL" });
    child = spawned;
    const stdout = new Response(spawned.stdout).text(); const stderr = new Response(spawned.stderr).text();
    let changed = false;
    for (let attempt = 0; attempt < 2000; attempt++) {
      const status = await lstat(output).catch(() => null);
      if (status?.isDirectory()) {
        await rename(replacedPath, replacedPath + "-saved");
        await symlink(sourceDirectory, replacedPath);
        changed = true; break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await Bun.sleep(1);
    }
    const [exit, out] = await Promise.all([child.exited, stdout, stderr]);
    expect(changed).toBe(true);
    expect(exit).toBe(1);
    expect(out).toBe("");
    expect((await readdir(sourceDirectory)).sort()).toEqual(before);
    const target = replaced === "output" ? sourceDirectory : join(sourceDirectory, "artifacts");
    for (const name of ["fleur-ordinary.tgz", "fleur-internal-native-candidate.tgz", "build-evidence.json"]) expect(await Bun.file(join(target, name)).exists()).toBe(false);
    expect((await lstat(replacedPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(replacedPath)).toBe(sourceDirectory);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.exited; }
    await rm(scratch, { recursive: true, force: true });
  }
}, 20000);

test.each(["inventoried", "opened"] as const)("replacing the %s parent before output creation cannot create a directory inside source", async (phase) => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-creation-race-"));
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const archive = join(scratch, "source.tgz");
    expect((await command([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], repository, environment)).exit).toBe(0);
    expect((await extract(archive, scratch, scratch, environment)).exit).toBe(0);
    const source = join(scratch, "package"); await mkdir(join(source, "scripts"));
    for (const name of ["build-native-candidate.ts", "native-candidate-ubuntu24-amd64.json", "candidate-command-observer.ts"]) await copyFile(join(repository, "scripts", name), join(source, "scripts", name));
    await mkdir(join(scratch, "outside"));
    const parent = await realpath(join(scratch, "outside"));
    const output = join(parent, "artifacts");
    const sourceDirectory = join(source, "src"); const before = (await readdir(sourceDirectory)).sort();
    const preload = join(scratch, "replace-parent.ts");
    // Replace the external filesystem node after its inventory, before any output mutation.
    await writeFile(preload, `import * as fs from "node:fs/promises";
import { mock } from "bun:test";
const original = { ...fs }; let changed = false;
mock.module("node:fs/promises", () => ({ ...original, lstat: async (...args: Parameters<typeof fs.lstat>) => {
  const result = await Reflect.apply(original.lstat, original, args);
  if (!changed && ${JSON.stringify(phase)} === "inventoried" && String(args[0]) === "/") {
    changed = true; await original.rename(${JSON.stringify(parent)}, ${JSON.stringify(parent + "-saved")});
    await original.symlink(${JSON.stringify(sourceDirectory)}, ${JSON.stringify(parent)});
  }
  return result;
}, open: async (...args: Parameters<typeof fs.open>) => {
  const result = await Reflect.apply(original.open, original, args);
  if (!changed && ${JSON.stringify(phase)} === "opened" && String(args[0]) === ${JSON.stringify(parent)}) {
    changed = true; await original.rename(${JSON.stringify(parent)}, ${JSON.stringify(parent + "-saved")});
    await original.symlink(${JSON.stringify(sourceDirectory)}, ${JSON.stringify(parent)});
  }
  return result;
} }));
`);
    const built = await command([process.execPath, "--preload", preload, join(source, "scripts/build-native-candidate.ts"), "--out", output], source, environment);
    expect(built.exit).toBe(1);
    expect(built.stdout).toBe("");
    expect((await readdir(sourceDirectory)).sort()).toEqual(before);
    expect((await lstat(parent)).isSymbolicLink()).toBe(true);
    expect(await readlink(parent)).toBe(sourceDirectory);
    expect(await readdir(parent + "-saved")).toEqual(phase === "opened" ? ["artifacts"] : []);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);

test("produced candidate observes the unchanged privileged local-plan command result", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-observer-"));
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const output = join(scratch, "artifacts");
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output], repository, environment);
    expect(built.exit, built.stderr).toBe(0);
    expect((await extract(join(output, "fleur-internal-native-candidate.tgz"), scratch, scratch, environment)).exit).toBe(0);
    const tools = join(scratch, "tools"); await mkdir(tools);
    await writeFile(join(tools, "sudo"), `#!${process.execPath}\nawait Bun.write(${JSON.stringify(join(scratch, "invocation.json"))},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));await Bun.write(${JSON.stringify(join(scratch, 'calls'))},(await Bun.file(${JSON.stringify(join(scratch, 'calls'))}).exists()?await Bun.file(${JSON.stringify(join(scratch, 'calls'))}).text():'')+'called\\n');process.stdout.write(process.env.OBS_TEXT??'local plan diagnostic\\n');process.stderr.write(process.env.OBS_TEXT??'E: fixture resolver refused\\n');process.exit(100);\n`, { mode: 0o700 });
    const args = ["sudo", "-n", "apt-get", "--simulate", "--no-download", "--no-remove", "--no-upgrade", "install", "/owned/frozen.deb"];
    const adapter = join(scratch, "package/bin/candidate-command-observer.ts");
    const evaluated = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const host=productionHost();const adapter=${JSON.stringify(adapter)};const observed=await Bun.file(adapter).exists()?(await import(adapter)).observeCandidateCommands(host):host;const result=await observed.run(${JSON.stringify(args)},1000,{cwd:${JSON.stringify(scratch)}});console.log(JSON.stringify(result));`], scratch, { ...environment, PATH: tools });
    expect(evaluated.exit).toBe(0);
    expect(JSON.parse(evaluated.stdout)).toEqual({ status: "completed", exitCode: 100, stdout: "local plan diagnostic\n", stderr: "E: fixture resolver refused\n" });
    expect(JSON.parse(await readFile(join(scratch, "invocation.json"), "utf8"))).toEqual({ args: args.slice(1), cwd: await realpath(scratch) });
    expect(evaluated.stderr).toContain("FLEUR_NATIVE_COMMAND_OBSERVATION ");
    const trace = JSON.parse(evaluated.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length));
    expect(trace).toMatchObject({ formatVersion: 1, phase: "apt-local-archive-plan", status: "completed", exitCode: 100, stdout: "local plan diagnostic\n", stderr: "E: fixture resolver refused\n", stdoutTruncated: false, stderrTruncated: false });
    expect(await readFile(join(scratch, "calls"), "utf8")).toBe("called\n");
    const ptyProgram = `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(productionHost()).run(${JSON.stringify(args)},1000,{cwd:${JSON.stringify(scratch)}})));`;
    const ptyScript = `import os,pty,subprocess,select,time,json,signal
master,slave=pty.openpty(); child=None; data=bytearray()
try:
 child=subprocess.Popen(${JSON.stringify([process.execPath, "--eval", "__PROGRAM__"]).replace('"__PROGRAM__"', JSON.stringify(ptyProgram))},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=slave,start_new_session=True)
 os.close(slave); slave=-1; deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.05)[0]:
   try: part=os.read(master,16384)
   except OSError: break
   if not part: break
   data.extend(part)
   if len(data)>65536: raise RuntimeError('PTY output bound')
  if child.poll() is not None: break
 stdout,_=child.communicate(timeout=max(0.01,deadline-time.monotonic()))
 print(json.dumps({'exit':child.returncode,'stdout':stdout.decode(),'stderr':data.decode()}))
finally:
 if child is not None and child.poll() is None: os.killpg(child.pid,signal.SIGKILL);child.wait()
 if slave>=0: os.close(slave)
 os.close(master)
`;
    const pty = await command(["/usr/bin/python3", "-c", ptyScript], scratch, { ...environment, PATH: tools });
    expect(pty.exit, pty.stderr).toBe(0);
    const ptyResult = JSON.parse(pty.stdout);
    expect(ptyResult.exit).toBe(0);
    expect(JSON.parse(ptyResult.stdout)).toMatchObject({ exitCode: 100, stdout: "local plan diagnostic\n", stderr: "E: fixture resolver refused\n" });
    expect(JSON.parse(ptyResult.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length))).toMatchObject({ phase: "apt-local-archive-plan", exitCode: 100 });

    const longOutput = "é".repeat(2047) + "€" + "\n\u001b[31m";
    const bounded = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(productionHost()).run(${JSON.stringify(args)},1000,{cwd:${JSON.stringify(scratch)}})));`], scratch, { ...environment, PATH: tools, OBS_TEXT: longOutput });
    expect(bounded.exit).toBe(0);
    expect(JSON.parse(bounded.stdout)).toMatchObject({ stdout: longOutput, stderr: longOutput, exitCode: 100 });
    expect(bounded.stderr.trim().split("\n")).toHaveLength(1);
    const boundedTrace = JSON.parse(bounded.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length));
    expect(boundedTrace).toMatchObject({ stdout: "é".repeat(2047), stderr: "é".repeat(2047), stdoutTruncated: true, stderrTruncated: true });
    expect(Buffer.byteLength(boundedTrace.stdout)).toBeLessThanOrEqual(4096);
    expect(boundedTrace.stdout).not.toContain("�");
    for (const other of [args.map((arg) => arg === "-n" ? "-v" : arg), args.map((arg) => arg === "apt-get" ? "other-tool" : arg), args.filter((arg) => arg !== "--simulate"), args.filter((arg) => arg !== "--no-download"), [...args.slice(0, -1), "docker-ce=1"], args.map((arg) => arg === "install" ? "download" : arg)]) {
      const negative = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(productionHost()).run(${JSON.stringify(other)},1000,{cwd:${JSON.stringify(scratch)}})));`], scratch, { ...environment, PATH: tools });
      expect(negative.exit).toBe(0);
      expect(JSON.parse(negative.stdout)).toMatchObject({ exitCode: 100, stdout: "local plan diagnostic\n", stderr: "E: fixture resolver refused\n" });
      expect(negative.stderr).toBe("");
    }
    expect((await readFile(join(scratch, "calls"), "utf8")).trim().split("\n")).toHaveLength(9);
    const expired = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(productionHost()).run(${JSON.stringify(args)},0,{cwd:${JSON.stringify(scratch)}})));`], scratch, { ...environment, PATH: tools });
    expect(expired.exit).toBe(0);
    expect(JSON.parse(expired.stdout)).toEqual({ status: "timeout", stdout: "", stderr: "" });
    expect(JSON.parse(expired.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length))).toMatchObject({ status: "timeout", exitCode: null, stdout: "", stderr: "" });
    expect((await readFile(join(scratch, "calls"), "utf8")).trim().split("\n")).toHaveLength(9);
    const exceptional = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});const sentinel=new Error('owned context getter');try{await observeCandidateCommands(productionHost()).run(${JSON.stringify(args)},1000,{get outputLimitBytes(){throw sentinel;}});process.exit(9);}catch(error){console.log(JSON.stringify({sameException:error===sentinel}));}`], scratch, { ...environment, PATH: tools });
    expect(exceptional.exit).toBe(0);
    expect(JSON.parse(exceptional.stdout)).toEqual({ sameException: true });
    expect(exceptional.stderr).toBe("");
    expect((await readFile(join(scratch, "calls"), "utf8")).trim().split("\n")).toHaveLength(9);

  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);

test("a closed diagnostic pipe preserves the original candidate command outcome", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-closed-trace-"));
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const output = join(scratch, "artifacts");
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output], repository, environment);
    expect(built.exit, built.stderr).toBe(0);
    expect((await extract(join(output, "fleur-internal-native-candidate.tgz"), scratch, scratch, environment)).exit).toBe(0);
    const tools = join(scratch, "tools"); await mkdir(tools);
    await writeFile(join(tools, "sudo"), `#!${process.execPath}\nconst until=Date.now()+3000;while(!await Bun.file(process.env.PROBE_GATE).exists()){if(Date.now()>until)process.exit(124);await Bun.sleep(10);}process.stdout.write('owned-command-result\\n');process.stderr.write('owned-command-error\\n');process.exit(100);\n`, { mode: 0o700 });
    for (const [observed, full] of [[false, false], [true, false], [true, true]]) {
      const gate = join(scratch, (observed ? "observed" : "baseline") + (full ? "-full" : ""));
      const witness = gate + "-witness";
      const child = Bun.spawn([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(join(scratch, "package/bin/candidate-command-observer.ts"))});process.stderr.write('INTERNAL NATIVE CANDIDATE disclosure\\n');if(${full}){const {writeSync}=await import('node:fs');let bytes=0,errorCode=null;for(let i=0;i<1000;i++){try{bytes+=writeSync(2,Buffer.alloc(4096,120));}catch(error){errorCode=error.code;break;}}await Bun.write(${JSON.stringify(witness)},JSON.stringify({bytes,errorCode}));}const host=productionHost();console.log(JSON.stringify(await (${observed}?observeCandidateCommands(host):host).run(['sudo','-n','apt-get','--simulate','--no-download','install','/owned/frozen.deb'],4000)));`], { cwd: scratch, env: { ...environment, PATH: tools, PROBE_GATE: gate }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL" });
      const reader = child.stderr.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("INTERNAL NATIVE CANDIDATE disclosure");
      if (!full) await reader.cancel();
      await writeFile(gate, "release", { flag: "wx" });
      const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(JSON.parse(stdout)).toEqual({ status: "completed", stdout: "owned-command-result\n", stderr: "owned-command-error\n", exitCode: 100 });
      if (full) { await reader.cancel(); expect(JSON.parse(await readFile(witness, "utf8"))).toMatchObject({ bytes: expect.any(Number), errorCode: "EAGAIN" }); }
      expect(exit).toBe(0);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);

test("produced candidate install phase observes one unchanged external command", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-install-observer-"));
  try {
    const environment = { PATH: "", HOME: scratch, TMPDIR: scratch };
    const output = join(scratch, "artifacts");
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output], repository, environment);
    expect(built.exit, built.stderr).toBe(0);
    expect((await extract(join(output, "fleur-internal-native-candidate.tgz"), scratch, scratch, environment)).exit).toBe(0);
    const tools = join(scratch, "tools"); await mkdir(tools);
    const witness = join(scratch, "calls.json");
    await writeFile(join(tools, "sudo"), `#!${process.execPath}\nconst file=Bun.file(${JSON.stringify(witness)});const calls=await file.exists()?await file.json():[];calls.push({args:process.argv.slice(2),cwd:process.cwd()});await Bun.write(file,JSON.stringify(calls));if(process.env.PROBE_GATE){const until=Date.now()+3000;while(!await Bun.file(process.env.PROBE_GATE).exists()){if(Date.now()>until)process.exit(124);await Bun.sleep(5);}}process.stdout.write(process.env.OBS_TEXT??'actual install output\\n');process.stderr.write(process.env.OBS_TEXT??'actual install failure\\n');process.exit(100);\n`, { mode: 0o700 });
    const args = ["sudo", "-n", "apt-get", "--assume-yes", "--no-download", "--no-remove", "--no-upgrade", "install", "/owned/frozen.deb"];
    const adapter = join(scratch, "package/bin/candidate-command-observer.ts");
    const evaluated = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(join(scratch, "package/src/setup/host.ts"))});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});const host=observeCandidateCommands(observeCandidateCommands(productionHost(),'apt-local-archive-install'));console.log(JSON.stringify(await host.run(${JSON.stringify(args)},1000,{cwd:${JSON.stringify(scratch)}})));`], scratch, { ...environment, PATH: tools });
    expect(evaluated.exit).toBe(0);
    expect(JSON.parse(evaluated.stdout)).toEqual({ status: "completed", exitCode: 100, stdout: "actual install output\n", stderr: "actual install failure\n" });
    expect(JSON.parse(await readFile(witness, "utf8"))).toEqual([{ args: args.slice(1), cwd: await realpath(scratch) }]);
    expect(evaluated.stderr).toContain("FLEUR_NATIVE_COMMAND_OBSERVATION ");
    expect(evaluated.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(evaluated.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length))).toMatchObject({ phase: "apt-local-archive-install", status: "completed", exitCode: 100, stdout: "actual install output\n", stderr: "actual install failure\n" });
    const hostPath = join(scratch, "package/src/setup/host.ts");
    const execute = (invocation: string[], phase: string, extra: Record<string, string> = {}) => command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(hostPath)});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(productionHost(),${JSON.stringify(phase)}).run(${JSON.stringify(invocation)},1000,{cwd:${JSON.stringify(scratch)}})));`], scratch, { ...environment, PATH: tools, ...extra });
    let executed = 1;
    for (const other of [args.map((arg) => arg === "-n" ? "-v" : arg), args.map((arg) => arg === "apt-get" ? "other-tool" : arg), [...args, "--simulate"], args.filter((arg) => arg !== "--no-download"), args.filter((arg) => arg !== "--assume-yes"), args.filter((arg) => arg !== "--no-remove"), args.filter((arg) => arg !== "--no-upgrade"), [...args.slice(0, -1), "docker-ce=1"], args.map((arg) => arg === "install" ? "download" : arg), args.slice(0, -1)]) {
      const negative = await execute(other, "apt-local-archive-install");
      expect(negative.exit).toBe(0);
      expect(JSON.parse(negative.stdout)).toMatchObject({ exitCode: 100, stdout: "actual install output\n", stderr: "actual install failure\n" });
      expect(negative.stderr).toBe(""); executed++;
    }
    const unknown = await execute(args, "unknown-internal-phase");
    expect(unknown.exit).toBe(0); expect(unknown.stderr).toBe(""); executed++;
    const longOutput = "é".repeat(2047) + "€\n\u001b[31m";
    const bounded = await execute(args, "apt-local-archive-install", { OBS_TEXT: longOutput });
    expect(bounded.exit).toBe(0);
    expect(JSON.parse(bounded.stdout)).toMatchObject({ stdout: longOutput, stderr: longOutput, exitCode: 100 });
    expect(bounded.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(bounded.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length))).toMatchObject({ phase: "apt-local-archive-install", stdout: "é".repeat(2047), stderr: "é".repeat(2047), stdoutTruncated: true, stderrTruncated: true }); executed++;
    const exceptional = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(hostPath)});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});const host=observeCandidateCommands(observeCandidateCommands(productionHost(),'apt-local-archive-install'));const sentinel=new Error('owned context getter');try{await host.run(${JSON.stringify(args)},1000,{get outputLimitBytes(){throw sentinel;}});process.exit(9);}catch(error){console.log(JSON.stringify({same:error===sentinel}));}`], scratch, { ...environment, PATH: tools });
    expect(exceptional.exit).toBe(0); expect(JSON.parse(exceptional.stdout)).toEqual({ same: true }); expect(exceptional.stderr).toBe("");
    const expired = await command([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(hostPath)});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(observeCandidateCommands(productionHost(),'apt-local-archive-install')).run(${JSON.stringify(args)},0,{cwd:${JSON.stringify(scratch)}})));`], scratch, { ...environment, PATH: tools });
    expect(expired.exit).toBe(0); expect(JSON.parse(expired.stdout)).toEqual({ status: "timeout", stdout: "", stderr: "" });
    expect(JSON.parse(expired.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length))).toMatchObject({ phase: "apt-local-archive-install", status: "timeout", exitCode: null });
    expect((await Bun.file(witness).json()).length).toBe(executed);
    for (const [observed, full] of [[false, false], [true, false], [true, true]]) {
      const gate = join(scratch, (observed ? "observed" : "baseline") + (full ? "-full" : "")); const fillWitness = gate + "-witness";
      const child = Bun.spawn([process.execPath, "--eval", `const {productionHost}=await import(${JSON.stringify(hostPath)});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});process.stderr.write('INTERNAL NATIVE CANDIDATE disclosure\\n');if(${full}){const {writeSync}=await import('node:fs');let bytes=0,errorCode=null;for(let i=0;i<1000;i++){try{bytes+=writeSync(2,Buffer.alloc(4096,120));}catch(error){errorCode=error.code;break;}}await Bun.write(${JSON.stringify(fillWitness)},JSON.stringify({bytes,errorCode}));}const host=productionHost();console.log(JSON.stringify(await (${observed}?observeCandidateCommands(observeCandidateCommands(host,'apt-local-archive-install')):host).run(${JSON.stringify(args)},4000)));`], { cwd: scratch, env: { ...environment, PATH: tools, PROBE_GATE: gate }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL" });
      const reader = child.stderr.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("INTERNAL NATIVE CANDIDATE disclosure");
      if (!full) await reader.cancel(); await writeFile(gate, "release", { flag: "wx" });
      const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(JSON.parse(stdout)).toEqual({ status: "completed", stdout: "actual install output\n", stderr: "actual install failure\n", exitCode: 100 });
      if (full) { await reader.cancel(); expect(JSON.parse(await readFile(fillWitness, "utf8"))).toMatchObject({ bytes: expect.any(Number), errorCode: "EAGAIN" }); }
      expect(exit).toBe(0); executed++;
    }
    const ptyProgram = `const {productionHost}=await import(${JSON.stringify(hostPath)});const {observeCandidateCommands}=await import(${JSON.stringify(adapter)});console.log(JSON.stringify(await observeCandidateCommands(observeCandidateCommands(productionHost(),'apt-local-archive-install')).run(${JSON.stringify(args)},1000,{cwd:${JSON.stringify(scratch)}})));`;
    const ptyScript = `import os,pty,subprocess,select,time,json,signal
master,slave=pty.openpty();child=None;data=bytearray()
try:
 child=subprocess.Popen(${JSON.stringify([process.execPath, "--eval", "__PROGRAM__"]).replace('"__PROGRAM__"', JSON.stringify(ptyProgram))},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=slave,start_new_session=True)
 os.close(slave);slave=-1;deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  if select.select([master],[],[],0.05)[0]:
   try: part=os.read(master,16384)
   except OSError: break
   if not part: break
   data.extend(part)
   if len(data)>65536: raise RuntimeError('PTY output bound')
  if child.poll() is not None: break
 stdout,_=child.communicate(timeout=max(0.01,deadline-time.monotonic()))
 print(json.dumps({'exit':child.returncode,'stdout':stdout.decode(),'stderr':data.decode()}))
finally:
 if child is not None and child.poll() is None: os.killpg(child.pid,signal.SIGKILL);child.wait()
 if slave>=0: os.close(slave)
 os.close(master)
`;
    const pty = await command(["/usr/bin/python3", "-c", ptyScript], scratch, { ...environment, PATH: tools });
    expect(pty.exit, pty.stderr).toBe(0); const ptyResult = JSON.parse(pty.stdout);
    expect(ptyResult.exit).toBe(0); expect(JSON.parse(ptyResult.stdout)).toMatchObject({ exitCode: 100, stdout: "actual install output\n", stderr: "actual install failure\n" });
    expect(JSON.parse(ptyResult.stderr.trim().slice("FLEUR_NATIVE_COMMAND_OBSERVATION ".length))).toMatchObject({ phase: "apt-local-archive-install", exitCode: 100 }); executed++;
    expect((await Bun.file(witness).json()).length).toBe(executed);

  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);

test("candidate packaging does not resolve gzip or Node through the caller PATH", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-candidate-compression-"));
  try {
    const tools = join(scratch, "tools"); await mkdir(tools);
    const witness = join(scratch, "unexpected-tool");
    for (const name of ["gzip", "node"]) await writeFile(join(tools, name), `#!/bin/sh\necho unexpected > '${witness}'\nexit 99\n`, { mode: 0o700 });
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", join(scratch, "artifacts")], repository, { PATH: tools, HOME: scratch, TMPDIR: scratch });
    expect(built.exit, built.stderr).toBe(0);
    expect(await Bun.file(witness).exists()).toBe(false);
    expect(JSON.parse(built.stdout)).toMatchObject({ installationEvidence: "pending", runtimeSupport: "unverified" });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 20000);
