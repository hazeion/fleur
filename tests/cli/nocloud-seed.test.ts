import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const helper = resolve(import.meta.dir, "../../scripts/prepare-nocloud-seed.py");
const python = Bun.which("python3")!;
async function run(source: string, output: string, path?: string) {
  if (path === undefined && process.platform !== "darwin") path = await protocol(source);
  path ??= "/usr/bin:/bin";
  const child = Bun.spawn([python, "-I", helper, "--source", source, "--output", output], { env: { HOME: source, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 35000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { result: stdout.trim() ? JSON.parse(stdout) : {}, stderr, exit };
}
async function protocol(source: string, mutation = "") {
  const directory = await mkdtemp(join(resolve(source, ".."), "protocol-"));
  const body = await readFile(resolve(import.meta.dir, "fixtures/nocloud-hdiutil.py"), "utf8");
  await writeFile(join(directory, "hdiutil"), `#!${python}
${body}
${mutation}
`, { mode: 0o700 });
  return directory;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleur-seed-")); const source = join(root, "input"); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, "user-data"), "#cloud-config\nusers: []\n", { mode: 0o600 });
  await writeFile(join(source, "meta-data"), '{"instance-id":"owned-test"}\n', { mode: 0o600 });
  return { root, source, output: join(root, "seed.iso") };
}
test("NoCloud executable creates and authenticates an owned ISO without mounting it", async () => {
  const f = await fixture();
  try {
    const result = await run(f.source, f.output);
    expect(result.exit, JSON.stringify(result)).toBe(0);
    expect(result.result).toMatchObject({ formatVersion: 1, scope: "owned-nocloud-seed", ok: true, volumeLabel: "cidata" });
    expect(result.result.files).toEqual({ "meta-data": Bun.CryptoHasher.hash("sha256", await readFile(join(f.source, "meta-data")), "hex"), "user-data": Bun.CryptoHasher.hash("sha256", await readFile(join(f.source, "user-data")), "hex") });
    expect(Bun.CryptoHasher.hash("sha256", await readFile(f.output), "hex")).toBe(result.result.imageSha256);
    expect(result.result.imageBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const mutation of ["image.write_bytes(b'bad')", "data=bytearray(image.read_bytes());data[16*2048+40]=ord('X');image.write_bytes(data)", "data=bytearray(image.read_bytes());data[16*2048+80:16*2048+88]=bytes(8);data[17*2048+80:17*2048+88]=bytes(8);image.write_bytes(data)"]) {
  test("seed inspection rejects malformed or mislabeled output even after a successful tool exit", async () => {
    const f = await fixture();
    try {
      const path = await protocol(f.source, mutation.replaceAll("image", "output"));
      const result = await run(f.source, f.output, path);
      expect(result.exit).toBe(5);
      expect(result.result.ok).toBe(false);
      expect(result.result.preparationError).toMatch(/ISO|volume label/);
      expect(await Bun.file(f.output).exists()).toBe(false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test("an existing output remains unchanged and no overwrite option is used", async () => {
  const f = await fixture();
  try {
    await writeFile(f.output, "unrelated output");
    const result = await run(f.source, f.output, "/unavailable-tools");
    expect(result.exit).toBe(4);
    expect(await readFile(f.output, "utf8")).toBe("unrelated output");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("an extra source entry is rejected before seed-tool execution", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, "unexpected"), "preserve");
    const result = await run(f.source, f.output, "/unavailable-tools");
    expect(result.exit).toBe(4);
    expect(await readFile(join(f.source, "unexpected"), "utf8")).toBe("preserve");
    expect(await Bun.file(f.output).exists()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a seed tool cannot leave a successful leader's owned process group running", async () => {
  const f = await fixture(); const groupFile = join(f.root, "tool-group");
  try {
    const code = `import os,subprocess,sys
Path(${JSON.stringify(groupFile)}).write_text(str(os.getpgrp()))
subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)`;
    const result = await run(f.source, f.output, await protocol(f.source, code));
    expect(result.exit).not.toBe(0);
    expect(result.result.ok).toBe(false);
  } finally {
    if (await Bun.file(groupFile).exists()) {
      const group = Number(await readFile(groupFile, "utf8"));
      try { process.kill(-group, "SIGKILL"); } catch (error) { expect((error as { code?: string }).code).toBe("ESRCH"); }
    }
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing seed tools fail without an output or package-install fallback", async () => {
  const f = await fixture();
  try {
    const result = await run(f.source, f.output, "/unavailable-tools");
    expect(result.exit).toBe(4);
    expect(result.result.ok).toBe(false);
    expect(await Bun.file(f.output).exists()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("source file symlinks are refused and their unrelated targets preserved", async () => {
  const f = await fixture(); const target = join(f.root, "outside");
  try {
    await writeFile(target, "unrelated"); await unlink(join(f.source, "user-data")); await symlink(target, join(f.source, "user-data"));
    const result = await run(f.source, f.output, "/unavailable-tools");
    expect(result.exit).toBe(4);
    expect(await readFile(target, "utf8")).toBe("unrelated");
    expect(await Bun.file(f.output).exists()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const [name, bytes] of [["user-data", 65537], ["meta-data", 16385]] as const) {
  test(`seed input bounds reject oversized ${name} before tool execution`, async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.source, name), Buffer.alloc(bytes, 65));
      const result = await run(f.source, f.output, "/unavailable-tools");
      expect(result.exit).toBe(4);
      expect(await Bun.file(f.output).exists()).toBe(false);
      expect((await readFile(join(f.source, name))).length).toBe(bytes);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const scenario of ["source-bytes", "source-directory"] as const) {
  test(`seed construction rejects original ${scenario} drift before publication`, async () => {
    const f = await fixture();
    try {
      const change = scenario === "source-bytes"
        ? `Path(${JSON.stringify(join(f.source, "user-data"))}).write_text('concurrent replacement bytes')`
        : `import os\nos.rename(${JSON.stringify(f.source)},${JSON.stringify(join(f.root, "moved-input"))})\nPath(${JSON.stringify(f.source)}).mkdir(mode=0o700)`;
      const result = await run(f.source, f.output, await protocol(f.source, change));
      expect(result.exit).not.toBe(0);
      expect(result.result.ok).toBe(false);
      expect(await Bun.file(f.output).exists()).toBe(false);
      if (scenario === "source-bytes") expect(await readFile(join(f.source, "user-data"), "utf8")).toBe("concurrent replacement bytes");
      else expect(await Bun.file(join(f.root, "moved-input", "meta-data")).exists()).toBe(true);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

async function directoryInodes(root: string): Promise<number[]> {
  const values: number[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    values.push((await lstat(path)).ino, ...await directoryInodes(path));
  }
  return values;
}
test("cleanup preserves a foreign directory substituted for the original stage name", async () => {
  const f = await fixture(); const fact = join(f.root, "foreign-stage-inode");
  try {
    const change = `import os
stage=Path.cwd()
os.rename(stage,str(stage)+'-moved')
stage.mkdir(mode=0o700)
Path(${JSON.stringify(fact)}).write_text(str(stage.stat().st_ino))`;
    const result = await run(f.source, f.output, await protocol(f.source, change));
    expect(result.exit).toBe(5);
    expect(result.result.ok).toBe(false);
    expect(await directoryInodes(f.root)).toContain(Number(await readFile(fact, "utf8")));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("cleanup claims a checked image before deletion and retains a raced foreign replacement", async () => {
  const f = await fixture();
  try {
    const path = await protocol(f.source);
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/nocloud-cleanup-race.py"), helper, f.source, f.output, f.root], { env: { HOME: f.root, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 35000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const lines = stdout.trim().split("\n"); const result = JSON.parse(lines[0]!); const facts = JSON.parse(lines[1]!);
    expect(facts.replacementInserted, stderr).toBe(true);
    expect(exit).toBe(5);
    expect(result).toMatchObject({ ok: false, error: { code: "SEED_CLEANUP_UNCONFIRMED" } });
    expect(facts.foreignLocations).toHaveLength(1);
    expect(await readFile(join(f.root, facts.foreignLocations[0]), "utf8")).toBe("foreign seed replacement must survive");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
