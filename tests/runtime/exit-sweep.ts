import { readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

// The backstop for resources a test could not release itself. A failed assertion
// can skip the rest of a finally block and a test timeout can skip all of it, so
// exit-sweep.preload.ts runs this after the last test file. Each entry names only
// resources the test created: a unique temporary root or a unique ownership label.
const labels = new Set<string>(), roots = new Set<string>();

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore", timeout: 30_000 });
  if (!result.success) throw new Error(`${args[0]} ${args[1]} failed during the exit sweep`);
  return result.stdout.toString();
}
function removeLabelled(label: string) {
  const docker = Bun.which("docker") ?? "docker";
  const lines = (output: string) => output.split("\n").filter(Boolean);
  const containers = lines(run([docker, "ps", "--all", "--quiet", "--filter", `label=${label}`]));
  if (containers.length) run([docker, "rm", "--force", ...containers]);
  const volumes = lines(run([docker, "volume", "ls", "--quiet", "--filter", `label=${label}`]));
  if (volumes.length) run([docker, "volume", "rm", ...volumes]);
}
function bindings(root: string): string[] {
  try { return readdirSync(join(root, ".local/state/fleur/development")).filter(name => /^[a-f0-9]{64}$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function attempt(work: () => void) {
  // The sweep must not change the run's result, but a resource it could not release must be visible.
  try { work(); } catch (error) { process.stderr.write(`Exit sweep could not release a test resource: ${String(error)}\n`); }
}
export function sweep() {
  if (roots.size) attempt(() => {
    for (const line of run(["/bin/ps", "-axww", "-o", "pid=,command="]).split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid) continue;
      if ([...roots].some(root => match[2]!.includes(root))) try { process.kill(Number(match[1]), "SIGKILL"); } catch { /* It already exited. */ }
    }
  });
  for (const root of roots) {
    attempt(() => { for (const binding of bindings(root)) removeLabelled(`dev.fleur.development-binding=${binding}`); });
    attempt(() => rmSync(root, { recursive: true, force: true }));
  }
  for (const label of labels) attempt(() => removeLabelled(label));
}
/** Remove containers and volumes carrying this unique label unless the owner has already released them. */
export function sweepLabelAtExit(label: string): () => void {
  labels.add(label);
  return () => { labels.delete(label); };
}
/** At exit, kill any process naming this unique temporary root, remove its development resources, then remove the root. */
export function sweepDevelopmentRootAtExit(root: string) {
  if (!root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error("The exit sweep owns only temporary roots");
  roots.add(root);
}
