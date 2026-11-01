// Private subprocess protocol. Only the named verification commands construct these arguments.
// EOF on stdin revokes ownership even when SIGKILL prevents the CLI from running cleanup.
import { constants } from "node:os";
const owned: { pid?: number } = {};
let interrupted: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined, parentLost = false;
const retire = () => {
  const pid = owned.pid;
  if (pid === undefined) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => { interrupted ??= signal; retire(); });
void (async () => {
  try {
    for await (const chunk of Bun.stdin.stream()) { if (chunk.byteLength) break; }
  } catch { /* A failed ownership pipe also revokes the run. */ }
  finally { parentLost = true; retire(); }
})();
const child = Bun.spawn([process.execPath, "--no-env-file", ...process.argv.slice(2)], { detached: true, cwd: process.cwd(), env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
if (Number.isSafeInteger(child.pid) && child.pid > 1) owned.pid = child.pid;
if (interrupted || parentLost) retire();
const exit = await child.exited;
retire();
process.exit(interrupted ? 128 + constants.signals[interrupted] : parentLost ? 1 : exit);
