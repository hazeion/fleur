import { readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { NativeLease } from "../../src/runtime/native/lease";
import { RetainedLease, executionLabel } from "../../src/runtime/native/retained-lease";

// The backstop for resources a test could not release itself. A failed assertion
// can skip the rest of a finally block and a test timeout can skip all of it, so
// run-sweep.preload.ts runs this after the last test file. Each entry names only
// resources the test created: a unique temporary root or a unique ownership label.
// Each label maps to the Docker endpoint that owns it; undefined is the selected default.
const labels = new Map<string, string | undefined>(), roots = new Set<string>();
export const developmentBindingLabel = "dev.fleur.development-binding";

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore", timeout: 30_000 });
  if (!result.success) throw new Error(`${args[0]} ${args[1]} failed during the run sweep`);
  return result.stdout.toString();
}
function removeLabelled(label: string, endpoint?: string) {
  const docker = [Bun.which("docker") ?? "docker", ...(endpoint ? ["--host", endpoint] : [])];
  const lines = (output: string) => output.split("\n").filter(Boolean);
  const containers = lines(run([...docker, "ps", "--all", "--quiet", "--filter", `label=${label}`]));
  if (containers.length) run([...docker, "rm", "--force", ...containers]);
  const volumes = lines(run([...docker, "volume", "ls", "--quiet", "--filter", `label=${label}`]));
  if (volumes.length) run([...docker, "volume", "rm", ...volumes]);
}
function bindings(root: string): string[] {
  try { return readdirSync(join(root, ".local/state/fleur/development")).filter(name => /^[a-f0-9]{64}$/.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function attempt(work: () => void) {
  // The sweep must not change the run's result, but a resource it could not release must be visible.
  try { work(); } catch (error) { process.stderr.write(`Run sweep could not release a test resource: ${String(error)}\n`); }
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
    attempt(() => { for (const binding of bindings(root)) removeLabelled(`${developmentBindingLabel}=${binding}`); });
    attempt(() => rmSync(root, { recursive: true, force: true }));
  }
  for (const [label, endpoint] of labels) attempt(() => removeLabelled(label, endpoint));
}
/** Remove containers and volumes carrying this unique label unless the owner has already released them. */
export function sweepLabelAfterRun(label: string, endpoint?: string): () => void {
  labels.set(label, endpoint);
  return () => { labels.delete(label); };
}
type Lease = { readonly owner: string };
type LeaseClass = { create(owner: string, images: { endpoint: string }): Promise<Lease>; prototype: object };
/** Register each lease's owner labels when it is created, and release them once one of its retiring methods succeeds. */
function sweepLeases(lease: LeaseClass, ownerLabels: (owner: string) => string[], retiring: string[]) {
  const releases = new WeakMap<Lease, () => void>(), create = lease.create;
  lease.create = async function (owner, images) {
    const created = await create.call(this, owner, images);
    // The controller label comes first: removing it ends creation authority before its children are listed.
    const registered = ownerLabels(owner).map(label => sweepLabelAfterRun(label, images.endpoint));
    releases.set(created, () => { for (const release of registered) release(); });
    return created;
  };
  const prototype = lease.prototype as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of retiring) {
    const method = prototype[name]!;
    prototype[name] = async function (this: Lease, ...args: unknown[]) {
      const result = await method.apply(this, args);
      releases.get(this)?.();
      return result;
    };
  }
}
/**
 * Native execution names its containers by owner labels generated inside Fleur, and a failed test leaves them
 * behind: Bun kills the attach clients, and their controllers exit without being removed. Track every lease this
 * process creates so the sweep can remove them. Called once, from run-sweep.preload.ts.
 */
export function sweepNativeLeasesAfterRun() {
  sweepLeases(NativeLease, owner => [`dev.fleur.read-controller-owner=${owner}`, `fleur.compatibility.runtime-owner=fleur-read-${owner}`], ["cleanup"]);
  sweepLeases(RetainedLease, owner => [`${executionLabel}=${owner}`], ["cleanup", "release", "abandon"]);
}
/** After the run, kill any process naming this unique temporary root, remove its development resources, then remove the root. */
export function sweepDevelopmentRootAfterRun(root: string) {
  if (!root.startsWith(realpathSync(tmpdir()) + sep)) throw new Error("The run sweep owns only temporary roots");
  roots.add(root);
}
