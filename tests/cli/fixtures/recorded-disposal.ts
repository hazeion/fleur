// Filesystem/process/report fixture only; it never launches a VM or native helper.
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const mode = process.argv[2];
const root = await fs.mkdtemp(join(tmpdir(), "fleur-disposal-boundary-"));
const scratch = join(root, "scratch");
const actualRm = fs.rm; const actualMkdir = fs.mkdir; const actualWrite = fs.writeFile;
let owned: ReturnType<typeof Bun.spawn> | undefined;
try {
  await actualMkdir(scratch, { mode: 0o700 });
  await actualWrite(join(scratch, "overlay.qcow2"), "owned fixture payload");
  if (mode === "present") mock.module("node:fs/promises", () => ({ ...fs, rm: async (path: string, options: Parameters<typeof fs.rm>[1]) => {
    await actualRm(path, options);
    await actualMkdir(path, { mode: 0o700 });
    await actualWrite(join(path, "overlay.qcow2"), "replacement retained");
  } }));
  if (mode === "unknown") mock.module("node:fs/promises", () => ({ ...fs, rm: async () => { throw Object.assign(new Error("fixture removal uncertainty"), { code: "EIO" }); } }));
  if (mode === "unreaped") owned = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const { disposeRecordedGuestArtifacts } = await import(resolve(import.meta.dir, "../../../scripts/verify-fresh-linux.ts"));
  const result: Record<string, unknown> = { ok: true, guest: { ok: true }, helperMode: "recorded-prebuilt" };
  const exit = await disposeRecordedGuestArtifacts(result, scratch, owned ? owned.exitCode !== null : true, mode === "recovery");
  let retained: string | null = null;
  try { retained = await fs.readFile(join(scratch, "overlay.qcow2"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let ownedProcessStillLive = false;
  if (owned && owned.exitCode === null) { process.kill(owned.pid, 0); ownedProcessStillLive = true; }
  console.log(JSON.stringify({ result, retained, ownedProcessStillLive }));
  process.exitCode = exit;
} finally {
  if (owned) { if (owned.exitCode === null) owned.kill("SIGKILL"); await owned.exited; }
  await actualRm(root, { recursive: true, force: true });
}
