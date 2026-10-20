import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const archiveSha256 = "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18";
const preparation = resolve(import.meta.dir, "../../scripts/prepare-fresh-linux-guest.py");
let scratch: string;
let archive: string;
let python: string;
beforeAll(async () => {
  python = Bun.which("python3") ?? "";
  if (!python) throw new Error("Existing Python is required for the guest preparation protocol fixture");
  scratch = await mkdtemp(join(tmpdir(), "fleur-guest-bun-"));
  archive = join(scratch, "official.zip");
  const response = await fetch("https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip", { signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body) throw new Error("Official pinned Bun fixture acquisition failed");
  const file = await open(archive, "wx", 0o600);
  const hash = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 160 * 1024 * 1024) throw new Error("Pinned Bun fixture exceeded its archive bound");
      hash.update(chunk); await file.writeFile(chunk);
    }
  } finally { await file.close(); }
  if (hash.digest("hex") !== archiveSha256) throw new Error("Official Bun fixture failed its frozen SHA256");
}, 90000);
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });
async function guest() {
  const directory = await mkdtemp(join(scratch, "lab-"));
  await copyFile(archive, join(directory, "bun.zip"));
  const path = join(directory, "empty-path"); await mkdir(path);
  return { directory, path };
}
async function prepare(directory: string, path: string, fileLimit?: number) {
  const args = fileLimit === undefined ? [python, "-I", preparation] : [python, "-I", "-c", "import resource,runpy,sys;script=sys.argv[1];limit=int(sys.argv[2]);resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit));sys.argv=[script];runpy.run_path(script,run_name='__main__')", preparation, String(fileLimit)];
  const child = Bun.spawn(args, { cwd: directory, env: { HOME: directory, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000, killSignal: "SIGKILL" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { result: JSON.parse(stdout), stderr, exit };
}
test("actual guest preparation extracts authenticated Bun without guest unzip or any package installation", async () => {
  const { directory, path } = await guest();
  const result = await prepare(directory, path);
  expect(result.exit, JSON.stringify(result)).toBe(0);
  expect(result.result).toMatchObject({ formatVersion: 1, scope: "guest-bun-preparation", ok: true });
  expect(result.stderr).toBe("");
  const output = await readFile(join(directory, "bun"));
  expect(output.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const metadata = await lstat(join(directory, "bun"));
  expect(metadata.isFile()).toBe(true);
  expect(metadata.mode & 0o777).toBe(0o700);
  expect(metadata.size).toBeGreaterThan(1024 * 1024);
  expect(metadata.size).toBeLessThanOrEqual(256 * 1024 * 1024);
  expect(Bun.CryptoHasher.hash("sha256", await readFile(join(directory, "bun.zip")), "hex")).toBe(archiveSha256);
});

test("guest preparation rejects a symlink archive before creating executable output", async () => {
  const { directory, path } = await guest();
  await unlink(join(directory, "bun.zip"));
  await symlink(archive, join(directory, "bun.zip"));
  const result = await prepare(directory, path);
  expect(result.exit).toBe(4);
  expect(result.result.ok).toBe(false);
  expect(await Bun.file(join(directory, "bun")).exists()).toBe(false);
  expect(Bun.CryptoHasher.hash("sha256", await readFile(archive), "hex")).toBe(archiveSha256);
});

test("failed output writes remove only the partial executable owned by this preparation", async () => {
  const { directory, path } = await guest();
  const sentinel = join(directory, "unrelated.txt"); await writeFile(sentinel, "preserve me");
  const result = await prepare(directory, path, 65536);
  expect(result.exit).toBe(4);
  expect(result.result.ok).toBe(false);
  expect(result.result.ownedPartialRemoved).toBe(true);
  expect(await Bun.file(join(directory, "bun")).exists()).toBe(false);
  expect(await readFile(sentinel, "utf8")).toBe("preserve me");
});

for (const kind of ["regular", "symlink"] as const) {
  test(`guest preparation preserves a pre-existing ${kind} output and its target`, async () => {
    const { directory, path } = await guest();
    const sentinel = join(directory, "preserved.txt"); await writeFile(sentinel, "existing user data");
    if (kind === "regular") await writeFile(join(directory, "bun"), "existing executable");
    else await symlink(sentinel, join(directory, "bun"));
    const result = await prepare(directory, path);
    expect(result.exit).toBe(4);
    expect(result.result.ok).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("existing user data");
    expect(await readFile(join(directory, "bun"), "utf8")).toBe(kind === "regular" ? "existing executable" : "existing user data");
    expect((await lstat(join(directory, "bun"))).isSymbolicLink()).toBe(kind === "symlink");
  });
}

test("guest preparation refuses corrupted archive bytes before output creation", async () => {
  const { directory, path } = await guest();
  const file = await open(join(directory, "bun.zip"), "r+");
  try { await file.write(Buffer.from("BROKEN"), 0, 6, 0); } finally { await file.close(); }
  const result = await prepare(directory, path);
  expect(result.exit).toBe(4);
  expect(result.result.ok).toBe(false);
  expect(await Bun.file(join(directory, "bun")).exists()).toBe(false);
});

test("guest preparation rejects an oversized regular archive without reading or extracting it", async () => {
  const { directory, path } = await guest();
  const file = await open(join(directory, "bun.zip"), "r+");
  try { await file.truncate(160 * 1024 * 1024 + 1); } finally { await file.close(); }
  const result = await prepare(directory, path);
  expect(result.exit).toBe(4);
  expect(result.result.ok).toBe(false);
  expect(await Bun.file(join(directory, "bun")).exists()).toBe(false);
});

test("an output replaced during preparation is preserved and cleanup remains explicitly unconfirmed", async () => {
  const { directory, path } = await guest();
  const running = prepare(directory, path);
  const output = join(directory, "bun");
  const deadline = performance.now() + 5000;
  while (!await Bun.file(output).exists()) {
    if (performance.now() >= deadline) throw new Error("Preparation did not reach its owned output boundary");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await rename(output, join(directory, "moved-partial"));
  await writeFile(output, "concurrent user file", { flag: "wx" });
  const result = await running;
  expect(result.exit).toBe(5);
  expect(result.result).toMatchObject({ ok: false, error: { code: "CLEANUP_UNCONFIRMED" } });
  expect(await readFile(output, "utf8")).toBe("concurrent user file");
  expect(await Bun.file(join(directory, "moved-partial")).exists()).toBe(true);
});

async function fault(directory: string, path: string, scenario: string) {
  const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/guest-preparation-faults.py"), preparation, scenario], { cwd: directory, env: { HOME: directory, PATH: path }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000, killSignal: "SIGKILL" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = stdout.trim().split("\n");
  return { result: JSON.parse(lines[0]!), facts: JSON.parse(lines[1]!), stderr, exit };
}
test("cleanup atomically claims the output and preserves a replacement introduced at its cleanup boundary", async () => {
  const { directory, path } = await guest();
  const result = await fault(directory, path, "cleanup-swap");
  expect(result.facts.replacementInjected).toBe(true);
  expect(result.exit).toBe(5);
  expect(result.result).toMatchObject({ ok: false, error: { code: "CLEANUP_UNCONFIRMED" } });
  expect(result.facts.foreignLocations).toHaveLength(1);
  expect(await readFile(join(directory, result.facts.foreignLocations[0]), "utf8")).toBe("unrelated concurrent output");
});

test("preparation authenticates final retained output bytes before reporting executable integrity", async () => {
  const { directory, path } = await guest();
  const result = await fault(directory, path, "output-mutation");
  expect(result.facts.inPlaceMutationInjected).toBe(true);
  expect(result.exit).toBe(4);
  expect(result.result.ok).toBe(false);
  expect(result.facts.outputExists).toBe(false);
  expect(result.result.ownedPartialRemoved).toBe(true);
});
