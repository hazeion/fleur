import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNativeImages } from "../../src/runtime/native/build";
import { nativeCommand } from "../../src/runtime/native/command";
import { NativeExecution } from "../../src/runtime/native/execution";
import { RetainedLease } from "../../src/runtime/native/retained-lease";

// ADR 0001 verification gate: "Controller loss, guard loss, delayed creation,
// PID reuse, startup failure, shutdown races and incomplete retirement cannot
// lead to unsafe reuse." Evidence comes from Docker itself, not from the
// controller's own reports.
const source = `
let moduleState = 0;
module.exports.run = async (request, exchange) => {
  moduleState++;
  // Announce entry through the trusted host only after admission, then spin.
  if (request.spin) { await exchange({ entered: true }); for (;;) {} }
  return { kind: "complete", value: { module: moduleState } };
};`;
let images: Awaited<ReturnType<typeof prepareNativeImages>>;
beforeAll(async () => { images = await prepareNativeImages(source); }, 300_000);
afterAll(async () => { await images?.dispose(); }, 60_000);

const docker = (...args: string[]) => nativeCommand(["docker", "--host", images.endpoint, ...args], 15_000);
const owned = (owner: string) => docker("ps", "--all", "--quiet", "--filter", `label=dev.fleur.execution-owner=${owner}`);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (await condition()) return true; await pause(20); }
  return condition();
}
/** Starts a spinning operation and resolves once its application code is executing. */
async function spinning(execution: NativeExecution) {
  let entered!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const busy = execution.execute({ spin: true }, () => { entered(); return null; }).then(() => undefined, (error: unknown) => error as Error);
  await Promise.race([admitted, busy]);
  expect(execution.diagnostics()[0]?.state).toBe("running");
  return { busy, slot: execution.diagnostics()[0]! };
}

for (let repeat = 1; repeat <= 2; repeat++) test(`guard loss quarantines the slot, no application process survives and the next operation uses a new slot, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    const { busy, slot } = await spinning(execution);
    // Kill only this slot's bound guard. Its host-PID view sees the guard by
    // its immutable arguments, which name the slot's application container.
    const killed = await docker("exec", `fleur-exec-${first.operation.slot}-guard`, "/usr/bin/python3", "-I", "-c", `
import os, signal
found = 0
for pid in filter(str.isdigit, os.listdir('/proc')):
    try: arguments = open('/proc/'+pid+'/cmdline', 'rb').read().split(b'\\0')
    except OSError: continue
    if b'/controller/retained_guard.py' in arguments and ${JSON.stringify(slot.container)}.encode() in arguments:
        os.kill(int(pid), signal.SIGKILL); found += 1
print(found)`);
    expect(killed).toBe("1");
    const failure = await busy;
    expect(failure).toBeInstanceOf(Error);
    // Uncertain retirement is never reported as an ordinary deadline result.
    expect((failure as Error & { evidence?: unknown }).evidence).toBeUndefined();
    // Verified removal of the application container retires every process in it.
    expect(await until(async () => await owned(first.operation.slot) === "", 15_000)).toBe(true);
    expect(await docker("ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${slot.container}`)).toBe("");
    expect(await until(() => execution.diagnostics().some(entry => entry.state === "idle"), 30_000)).toBe(true);
    const next = await execution.execute({}, () => null);
    expect(next.operation.slot).not.toBe(first.operation.slot);
    expect(next.operation.container).not.toBe(first.operation.container);
    expect(next.value).toEqual({ kind: "complete", value: { module: 1 } });
  } finally { await execution.close(); }
}, 120_000);

for (let repeat = 1; repeat <= 2; repeat++) test(`after controller loss the bound guard kills the application before its container is killed or removed, repeat ${repeat}`, async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  try {
    const first = await execution.execute({}, () => null);
    const { busy, slot } = await spinning(execution);
    const since = (Date.now() / 1000).toFixed(3);
    await docker("kill", `fleur-exec-controller-${first.operation.slot}`);
    expect(await busy).toBeInstanceOf(Error);
    expect(await until(async () => await owned(first.operation.slot) === "", 15_000)).toBe(true);
    const until_ = (Date.now() / 1000 + 1).toFixed(3);
    const events = (await docker("events", "--since", since, "--until", until_, "--filter", `container=${slot.container}`, "--format", "{{json .}}"))
      .split("\n").filter(Boolean).map(line => JSON.parse(line) as { Action: string; Actor: { Attributes: Record<string, string> } });
    const actions = events.map(event => event.Action.split(":")[0]);
    const exited = actions.indexOf("exec_die");
    const stopped = actions.findIndex(action => ["kill", "die", "destroy"].includes(action!));
    expect(exited).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(exited);
    // SIGKILL from the guard's pidfd, not a natural exit.
    expect(events[exited]!.Actor.Attributes.exitCode).toBe("137");
    expect(actions).toContain("destroy");
  } finally { await execution.close(); }
}, 120_000);

for (const stage of ["controller", "worker"] as const) test(`controller loss during slot creation (${stage} visible) never leaks or silently reuses owned containers`, async () => {
  const before = new Set((await docker("ps", "--all", "--format", "{{.Names}}", "--filter", "name=fleur-exec-controller-")).split("\n").filter(Boolean));
  const opening = NativeExecution.open(images, { capacity: 1 }).then(execution => ({ execution }), (error: unknown) => ({ error: error as Error }));
  let owner: string | undefined;
  const seen = await until(async () => {
    const names = (await docker("ps", "--all", "--format", "{{.Names}}", "--filter", "name=fleur-exec-")).split("\n").filter(Boolean);
    const controller = names.find(name => name.startsWith("fleur-exec-controller-") && !before.has(name));
    if (!controller) return false;
    owner = controller.slice("fleur-exec-controller-".length);
    return stage === "controller" || names.includes(`fleur-exec-${owner}-worker`);
  }, 30_000);
  expect(seen).toBe(true);
  await docker("kill", `fleur-exec-controller-${owner}`).catch(() => "");
  const opened = await opening;
  console.info("[delayed-creation]", stage, "error" in opened ? opened.error.message : "ready-before-kill");
  const ids = async () => (await owned(owner!)).split("\n").filter(Boolean);
  try {
    if ("execution" in opened) {
      // The slot became ready before the kill landed: it is retired at once and
      // never reused; background replacement serves the next operation.
      expect(await until(async () => await owned(owner!) === "", 15_000)).toBe(true);
      expect(await until(() => opened.execution.diagnostics().some(slot => slot.state === "idle"), 30_000)).toBe(true);
      const next = await opened.execution.execute({}, () => null);
      expect(next.operation.slot).not.toBe(owner);
      expect(next.value).toEqual({ kind: "complete", value: { module: 1 } });
      return;
    }
    // Startup fails closed. Any accepted creation is removed, or uncertainty is
    // reported for operator recovery instead of being hidden.
    expect(["PREREQUISITE_UNAVAILABLE", "EXECUTION_RECOVERY_REQUIRED"]).toContain(opened.error.message);
    const reported = await ids();
    if (opened.error.message === "PREREQUISITE_UNAVAILABLE") expect(reported).toEqual([]);
    // A delayed creation request never materializes a new owned container afterwards.
    await pause(3000);
    expect((await ids()).filter(id => !reported.includes(id))).toEqual([]);
  } finally {
    if ("execution" in opened) await opened.execution.close();
    for (const id of (await owned(owner!)).split("\n").filter(Boolean)) await docker("rm", "--force", id).catch(() => "");
  }
}, 120_000);

// #67: capacity held by a slot whose removal could not be verified is visible,
// not hidden until shutdown.
test("a slot whose removal cannot be verified stays visible while it occupies capacity", async () => {
  const execution = await NativeExecution.open(images, { capacity: 1 });
  let owner: string | undefined;
  try {
    owner = (await execution.execute({}, () => null)).operation.slot;
    const guard = `fleur-exec-${owner}-guard`;
    // A foreign container takes the guard host's name, so recovery cannot
    // verify ownership of what it would remove.
    await docker("rm", "--force", guard);
    await docker("create", "--name", guard, "--label", `dev.fleur.execution-owner=${owner}`, "--entrypoint", "/bin/true", images.worker);
    await docker("kill", `fleur-exec-controller-${owner}`);
    const visible = () => execution.diagnostics().some(slot => slot.slot === owner && slot.state === "quarantined");
    expect(await until(visible, 15_000)).toBe(true);
    // Recovery has failed by now; the slot stays listed for as long as it holds capacity.
    await pause(3000);
    expect(execution.diagnostics()).toEqual([expect.objectContaining({ slot: owner, state: "quarantined" })]);
    expect(await execution.execute({}, () => null).then(() => "served", (error: Error) => error.message)).toBe("QUERY_TIMEOUT");
    expect(execution.diagnostics()).toEqual([expect.objectContaining({ slot: owner, state: "quarantined" })]);
    expect(await execution.close().then(() => "closed", (error: Error) => error.message)).toBe("EXECUTION_RECOVERY_REQUIRED");
  } finally {
    await execution.close().catch(() => {});
    if (owner) for (const id of (await owned(owner)).split("\n").filter(Boolean)) await docker("rm", "--force", id).catch(() => "");
  }
}, 120_000);

/**
 * Runs `work` with Fleur's Docker CLI calls forwarded to the real CLI, except
 * that `race` decides kill and forced removal. "concurrent" first performs the
 * same kill or `rm --force` once, as a slot's own controller does when it exits
 * after removing its application and guard containers while host recovery
 * runs. "refuse" fails a kill without performing it. "replace" removes the
 * kill's target and creates `impostor` (docker create arguments) in its place
 * before the kill, which then fails.
 */
async function withDockerRace<T>(race: "concurrent" | "refuse" | "replace", work: () => Promise<T>, impostor: readonly string[] = []): Promise<T> {
  const real = Bun.which("docker");
  if (!real) throw new Error("Docker CLI required");
  const directory = await mkdtemp(join(tmpdir(), "fleur-docker-race-"));
  await writeFile(join(directory, "docker"), `#!/bin/sh
case "${race}:$3:$4" in
  concurrent:kill:*|concurrent:rm:--force) ${JSON.stringify(real)} "$@" >/dev/null 2>&1 ;;
  refuse:kill:*) echo "refused by test" >&2; exit 1 ;;
  replace:kill:*) ${JSON.stringify(real)} "$1" "$2" rm --force "$6" >/dev/null 2>&1
    ${JSON.stringify(real)} "$1" "$2" create ${impostor.map(value => JSON.stringify(value)).join(" ")} >/dev/null 2>&1 ;;
esac
exec ${JSON.stringify(real)} "$@"
`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${directory}:${path}`;
  try { return await work(); } finally { process.env.PATH = path; await rm(directory, { recursive: true, force: true }); }
}

// #89: a host read deadline can quarantine a slot while its controller is
// still removing its own containers; the controller then exits by itself
// between recovery's inspection and its kill. That kill failing must not leave
// the slot unrecoverable, and recovery is still verified by inspection alone.
test("quarantine recovery verifies a controller that stopped itself and its removed containers, and still refuses a controller it could not stop or no longer identifies", async () => {
  for (const race of ["concurrent", "refuse", "replace"] as const) {
    const owner = randomUUID();
    const lease = await RetainedLease.create(owner, images);
    try {
      const start = (name: string, image: string) => docker("run", "--detach", "--name", name, "--label", `dev.fleur.execution-owner=${owner}`,
        "--network=none", "--pull=never", "--entrypoint", "/bin/sleep", image, "infinity");
      await start(lease.controllerName, images.controller);
      const worker = await start(lease.workerName, images.worker), guard = await start(lease.guardName, images.controller);
      await lease.bindSlot({ worker, init: 2, guard, boot: randomUUID() });
      // A stopped container with the controller's name, label and image, but not its identity.
      const impostor = ["--name", lease.controllerName, "--label", `dev.fleur.execution-owner=${owner}`, "--network=none", "--pull=never", "--entrypoint", "/bin/true", images.controller];
      const recovery = await withDockerRace(race, () => lease.cleanup(), impostor).then(() => "recovered", (error: Error) => error.message);
      const running = (await docker("ps", "--quiet", "--no-trunc", "--filter", `label=dev.fleur.execution-owner=${owner}`)).split("\n").filter(Boolean);
      if (race === "concurrent") {
        expect(recovery).toBe("recovered");
        expect(await owned(owner)).toBe("");
      } else if (race === "refuse") {
        // Creation authority that is still running is never reported as stopped.
        expect(recovery).toBe("CREATION_AUTHORITY_UNCONFIRMED");
        expect(running).toHaveLength(3);
      } else {
        // Another container under the controller's name never verifies that the
        // controller stopped, so no child is touched.
        expect(recovery).toBe("CLEANUP_OWNERSHIP_UNCONFIRMED");
        expect(running.sort()).toEqual([worker, guard].sort());
      }
    } finally {
      for (const id of (await owned(owner)).split("\n").filter(Boolean)) await docker("rm", "--force", id).catch(() => "");
      await rm(lease.recoveryDirectory, { recursive: true, force: true });
    }
  }
}, 120_000);
