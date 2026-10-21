import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../scripts/archive-fresh-linux-probe.ts");
async function command(args: string[], cwd: string, env?: Record<string, string | undefined>) {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "fleur-probe-archive-")); const repo = join(root, "repo"); await mkdir(repo);
  const runtime = join(repo, "experiments/compatibility/runtime-probe"); const rendering = join(repo, "experiments/compatibility/rendering");
  await mkdir(runtime, { recursive: true }); await mkdir(rendering, { recursive: true });
  await writeFile(join(runtime, "run.py"), `import json,pathlib\nr=pathlib.Path(__file__).parent.parent/'rendering'\nprint(json.dumps({'package':(r/'package.json').read_text(),'lock':(r/'bun.lock').read_text()}))\n`);
  await writeFile(join(rendering, "package.json"), '{"name":"frozen-rendering"}\n'); await writeFile(join(rendering, "bun.lock"), 'frozen-lock\n');
  expect((await command(["git", "init", "-q"], repo)).exit).toBe(0);
  expect((await command(["git", "add", "experiments"], repo)).exit).toBe(0);
  expect((await command(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "frozen fixture"], repo)).exit).toBe(0);
  const commit = (await command(["git", "rev-parse", "HEAD"], repo)).stdout.trim();
  return { root, repo, commit, runtime, rendering };
}
test("restriction archive executes with its tracked sibling inputs from one exact commit, excluding dirty and untracked files", async () => {
  const { root, repo, commit, runtime, rendering } = await repository();
  try {
    await writeFile(join(rendering, "package.json"), '{"name":"dirty replacement"}'); await writeFile(join(runtime, "untracked-secret"), "must not ship");
    const out = join(root, "probe.tar"); const result = await command([process.execPath, script, "--repository", repo, "--commit", commit, "--out", out], root);
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ formatVersion: 1, scope: "fresh-linux-restriction-archive", ok: true, commit });
    const python = Bun.which("python3"); expect(python).not.toBeNull();
    const extracted = join(root, "extracted"); await mkdir(extracted);
    const observed = await command([python!, "-I", "-c", "import pathlib,subprocess,sys,tarfile; root=pathlib.Path(sys.argv[2]); t=tarfile.open(sys.argv[1]); t.extractall(root,filter='data'); assert not (root/'experiments/compatibility/runtime-probe/untracked-secret').exists(); subprocess.run([sys.executable,'-I',str(root/'experiments/compatibility/runtime-probe/run.py')],check=True)", out, extracted], root);
    expect(observed.exit, observed.stderr).toBe(0);
    expect(JSON.parse(observed.stdout)).toEqual({ package: '{"name":"frozen-rendering"}\n', lock: 'frozen-lock\n' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("restriction archive rejects Git attributes that remove required tracked bytes instead of reporting incomplete success", async () => {
  const { root, repo } = await repository();
  try {
    await writeFile(join(repo, ".gitattributes"), "experiments/compatibility/rendering/package.json export-ignore\n");
    expect((await command(["git", "add", ".gitattributes"], repo)).exit).toBe(0);
    expect((await command(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "attributes fixture"], repo)).exit).toBe(0);
    const commit = (await command(["git", "rev-parse", "HEAD"], repo)).stdout.trim();
    const output = join(root, "probe.tar");
    const result = await command([process.execPath, script, "--repository", repo, "--commit", commit, "--out", output], root);
    expect(result.exit).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { code: "RESTRICTION_ARCHIVE_FAILED" } });
    expect(await Bun.file(output).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const scenario of ["missing-tracked-input", "invalid-commit", "existing-output"] as const) {
  test(`restriction archive fails closed and preserves owned input/output boundaries: ${scenario}`, async () => {
    const { root, repo, commit, rendering } = await repository();
    try {
      let selected = commit;
      if (scenario === "missing-tracked-input") {
        expect((await command(["git", "rm", "experiments/compatibility/rendering/bun.lock"], repo)).exit).toBe(0);
        expect((await command(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "missing tracked lock"], repo)).exit).toBe(0);
        selected = (await command(["git", "rev-parse", "HEAD"], repo)).stdout.trim();
        await writeFile(join(rendering, "bun.lock"), "untracked replacement must not be used");
      }
      if (scenario === "invalid-commit") selected = "0".repeat(40);
      const output = join(root, "probe.tar");
      if (scenario === "existing-output") await writeFile(output, "preserve existing archive");
      const observed = await command([process.execPath, script, "--repository", repo, "--commit", selected, "--out", output], root);
      expect(observed.exit).toBe(4);
      expect(JSON.parse(observed.stdout)).toMatchObject({ ok: false, error: { code: "RESTRICTION_ARCHIVE_FAILED" } });
      expect(observed.stderr).toBe("");
      if (scenario === "existing-output") expect(await Bun.file(output).text()).toBe("preserve existing archive");
      else expect(await Bun.file(output).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const scenario of ["validated-path-replacement", "foreign-cleanup-replacement", "parent-replacement"] as const) {
  test(`restriction archive retains byte and cleanup custody under an owned command-protocol race: ${scenario}`, async () => {
    const { root, repo, commit } = await repository();
    try {
      const python = Bun.which("python3"); expect(python).not.toBeNull();
      const tools = join(root, "tools"); await mkdir(tools);
      const directory = join(root, "output"); await mkdir(directory, { mode: 0o700 });
      const output = join(directory, "probe.tar"); const marker = join(root, "injected");
      const program = scenario === "foreign-cleanup-replacement" ? "import sys;sys.exit(1)\n" : `import os,pathlib,subprocess,sys\nout=pathlib.Path(${JSON.stringify(output)});body=out.read_bytes();saved=out.with_suffix('.original');out.rename(saved);out.write_bytes(body)\ntry:os.fstat(3);extra=(3,)\nexcept OSError:extra=()\nr=subprocess.run([sys.executable,*sys.argv[1:]],stdin=sys.stdin.buffer,pass_fds=extra)\nif r.returncode==0:\n ${scenario === "parent-replacement" ? `out.parent.rename(pathlib.Path(${JSON.stringify(join(root, "parked-output"))}));out.parent.mkdir(mode=0o700);out.write_bytes(b'foreign output must survive')` : "saved.write_bytes(b'X'*len(body));out.rename(out.with_suffix('.validated-copy'));saved.rename(out)"}\n pathlib.Path(${JSON.stringify(marker)}).write_text('yes')\nsys.exit(r.returncode)\n`;
      await writeFile(join(tools, "python3"), `#!${python}\n${program}`, { mode: 0o700 });
      let entry = script;
      if (scenario === "foreign-cleanup-replacement") {
        entry = join(root, "launcher.mjs");
        await writeFile(entry, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const output=${JSON.stringify(output)};const marker=${JSON.stringify(marker)};const root=${JSON.stringify(root)};const rename=fs.promises.rename;const unlink=fs.promises.unlink;let injected=false;async function inject(path){if(path===output&&!injected){injected=true;await rename(output,${JSON.stringify(join(root, "original-owned.tar"))});await fs.promises.writeFile(output,'foreign output must survive');await fs.promises.writeFile(marker,'yes');await fs.promises.writeFile(root+'/foreign-location',output);}}fs.promises.rename=async function(from,to){await inject(from);const result=await rename(from,to);if(from===output&&injected)await fs.promises.writeFile(root+'/foreign-location',to);return result;};fs.promises.unlink=async function(path){await inject(path);return unlink(path);};syncBuiltinESMExports();process.argv=[process.execPath,${JSON.stringify(script)},...process.argv.slice(2)];await import(${JSON.stringify(script)});`);
      }
      const observed = await command([process.execPath, entry, "--repository", repo, "--commit", commit, "--out", output], root, { ...process.env, PATH: tools + ":" + process.env.PATH });
      const evidence = JSON.parse(observed.stdout);
      expect(observed.exit, observed.stderr).toBe(4);
      expect(evidence).toMatchObject({ ok: false, error: { code: "RESTRICTION_ARCHIVE_FAILED" } });
      expect(await Bun.file(marker).text()).toBe("yes");
      if (scenario === "foreign-cleanup-replacement") {
        const retained = await Bun.file(await Bun.file(join(root, "foreign-location")).text()).text();
        expect(retained).toBe("foreign output must survive");
        const retainedPath = evidence.cleanup.retainedPath;
        expect(typeof retainedPath).toBe("string");
        expect(await Bun.file(retainedPath).text()).toBe("foreign output must survive");
        expect(evidence.cleanup).toMatchObject({ state: "unconfirmed", retainedPath });
      }
      if (scenario === "parent-replacement") expect(await Bun.file(output).text()).toBe("foreign output must survive");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
