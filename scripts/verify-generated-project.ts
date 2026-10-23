import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// This checks generated tooling, not a Fleur application runtime or production artifact.
const repository = resolve(import.meta.dir, "..");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "fleur-generated-verification-")));
const checks: string[] = [];
const bunOnly = join(scratch, "bun-only");
await mkdir(bunOnly);
await symlink(process.execPath, join(bunOnly, "bun"));
const environment = { PATH: bunOnly, HOME: scratch, TMPDIR: scratch, BUN_INSTALL_CACHE_DIR: join(scratch, "cache") };
async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text = (text + decoder.decode(chunk.value, { stream: true })).slice(-16384);
  }
}
async function run(args: string[], cwd: string, expected = 0): Promise<string> {
  const child = Bun.spawn(args, { cwd, env: environment, timeout: 180000, killSignal: "SIGKILL", stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([boundedText(child.stdout), boundedText(child.stderr), child.exited]);
  if (exit !== expected) throw new Error(`Generated tooling check failed: ${args.slice(1).join(" ")}\nExpected exit ${expected}; received ${exit}.\n${stdout}\n${stderr}`);
  return stdout + stderr;
}
try {
  const archive = join(scratch, "release.tgz");
  await run([process.execPath, "pm", "pack", "--filename", archive], repository);
  // GNU tar's gzip helper uses PATH, which is intentionally Bun-only here.
  // Keep that isolation and decode our own packed archive with the pinned Bun.
  const uncompressed = join(scratch, "release.tar");
  await writeFile(uncompressed, Bun.gunzipSync(await readFile(archive)), { flag: "wx", mode: 0o600 });
  await run(["/usr/bin/tar", "-xf", uncompressed, "-C", scratch], scratch);
  const project = join(scratch, "application");
  const created = JSON.parse(await run([process.execPath, join(scratch, "package", "bin", "fleur.ts"), "new", project, "--no-git", "--json"], scratch));
  if (created.formatVersion !== 1 || created.ok !== true) throw new Error("Packed creation did not return success JSON.");
  checks.push("packed creation with Node unavailable");
  await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], project);
  await run([process.execPath, "install", "--cwd", "lint", "--frozen-lockfile", "--ignore-scripts"], project);
  checks.push("two real frozen dependency graphs with an isolated cache and ignored lifecycle scripts");
  await writeFile(join(project, "shared", "value.ts"), 'export const label: string = "Ready";\n');
  await writeFile(join(project, "server", "value.ts"), 'import { label } from "../shared/value.ts";\nexport const serverLabel: string = label;\n');
  await writeFile(join(project, "client", "Island.tsx"), 'import { useState } from "preact/hooks";\nimport { label } from "../shared/value.ts";\nexport function Island() { const [count, setCount] = useState(0); return <button class="p-4" onClick={() => setCount(count + 1)}>{label}: {count}</button>; }\n');
  await writeFile(join(project, "client", "entry.ts"), 'export { Island } from "./Island.tsx";\n');
  for (let pass = 0; pass < 2; pass++) {
    await run([process.execPath, "run", "types"], project);
    await run([process.execPath, "run", "lint"], project);
  }
  checks.push("strict explicit .ts/.tsx imports and real Preact fixture pass compiler and both lint engines twice");
  const invalid = join(project, "shared", "invalid.ts");
  try {
    await writeFile(invalid, 'export const wrong: number = "wrong";\n');
    const typeFailure = await run([process.execPath, "run", "types"], project, 1);
    if (!typeFailure.includes("TS2322")) throw new Error("The negative type fixture failed for an unintended reason.");
    await writeFile(invalid, "const unused = 1;\nexport {};\n");
    const lintFailure = await run([process.execPath, "run", "lint"], project, 1);
    if (!lintFailure.includes("no-unused-vars")) throw new Error("The negative lint fixture failed for an unintended reason.");
  } finally { await unlink(invalid); }
  checks.push("incompatible value and unused binding reject for their intended diagnostics");
  await run([process.execPath, "run", "types"], project);
  await run([process.execPath, "run", "lint"], project);
  const output = join(project, ".fleur", "toolchain-proof");
  await run([process.execPath, "build", "client/entry.ts", "--target=browser", "--outdir", output], project);
  if (!(await readFile(join(output, "entry.js"))).length) throw new Error("The real Preact toolchain bundle was empty.");
  checks.push("Bun browser bundling toolchain proof, without an application build or runtime claim");
  process.stdout.write(JSON.stringify({ ok: true, nodeOnPath: false, checks }) + "\n");
} finally {
  // Only this uniquely owned disposable fixture is removed.
  if (dirname(scratch) === await realpath(tmpdir())) await rm(scratch, { recursive: true, force: true });
}
