import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * observe-desktop-control.ts ships scripts/desktop-control-probe.ts verbatim into an owned container as
 * `bun -e <source>` (entrypoint /usr/local/bin/bun, --network none, --read-only, no Fleur checkout).
 * The program must therefore load with no repository on disk: any relative import makes the manager
 * exit before it can print its evidence frame, and the preflight reports MANAGER_EXITED_WITHOUT_EVIDENCE.
 * Outside Linux the loaded program refuses with its own NATIVE_LINUX_MANAGER_REQUIRED frame, which proves
 * the module itself resolved and executed.
 */
test("the desktop control probe loads standalone from an empty directory, as the container runs it", async () => {
  const source = await readFile(resolve(import.meta.dir, "../../scripts/desktop-control-probe.ts"), "utf8");
  const empty = await mkdtemp(join(tmpdir(), "fleur-probe-standalone-"));
  try {
    const running = Bun.spawn([process.execPath, "--no-env-file", "-e", source], { cwd: empty, env: { PATH: "" }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => running.kill("SIGKILL"), 20_000);
    try {
      const [exit, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]);
      expect(stderr).not.toContain("Cannot find module");
      expect(stderr).toBe("");
      const frame = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
      expect(frame).toMatchObject({ formatVersion: 1, scope: "desktop-linux-control-capability", ok: false, runtimeAdmission: false });
      expect(typeof frame.error).toBe("string");
      expect(exit).toBe(4);
    } finally { clearTimeout(timer); }
  } finally { await rm(empty, { recursive: true, force: true }); }
});
