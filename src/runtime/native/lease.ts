import { mkdtemp, writeFile, rename, rm, open, readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateEndpoint, type NativeImages } from "./endpoint";
import { nativeCommand } from "./command";

type Metadata = { Id: string; Name: string; Image: string; State: { Running: boolean; Pid: number }; Config: { Labels: Record<string, string>; Entrypoint: string[]; Cmd: string[] | null }; };
export interface WorkerBinding { id: string; pid: number; boot: string; }
export interface GuardBinding extends WorkerBinding { guard: string; deadline: number; }
function workerBinding(value: unknown): WorkerBinding {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 3 || !("id" in value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)
    || !("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 1 || !("boot" in value) || typeof value.boot !== "string" || !/^[a-f0-9-]{36}$/.test(value.boot)) throw new Error("WORKER_IDENTITY_UNCONFIRMED");
  return { id: value.id, pid: value.pid, boot: value.boot };
}
function guardBinding(value: unknown, worker: WorkerBinding | undefined): GuardBinding {
  if (!worker || !value || typeof value !== "object" || Object.keys(value).length !== 5) throw new Error("GUARD_IDENTITY_UNCONFIRMED");
  const data = value as GuardBinding;
  if (data.id !== worker.id || data.pid !== worker.pid || data.boot !== worker.boot || !/^[a-f0-9]{64}$/.test(data.guard)
    || typeof data.deadline !== "number" || !Number.isFinite(data.deadline) || data.deadline <= 0) throw new Error("GUARD_IDENTITY_UNCONFIRMED");
  return { ...data };
}
export class NativeLease {
  readonly owner: string;
  readonly controllerName: string;
  readonly workerName: string;
  readonly guardName: string;
  readonly #directory: string;
  readonly #images: NativeImages;
  #creationPending: "worker" | "guard" | null = null;
  #worker: WorkerBinding | undefined;
  #guard: GuardBinding | undefined;
  private constructor(owner: string, images: NativeImages, directory: string) {
    this.owner = owner; this.#images = images; this.#directory = directory;
    this.controllerName = `fleur-read-controller-${owner}`;
    this.workerName = `fleur-read-${owner}-worker`;
    this.guardName = `fleur-read-${owner}-guard`;
  }
  static async create(owner: string, images: NativeImages): Promise<NativeLease> {
    validateEndpoint(images.endpoint);
    const lease = new NativeLease(owner, images, await mkdtemp(join(tmpdir(), "fleur-native-lease-")));
    await lease.#save();
    return lease;
  }
  get recoveryDirectory(): string { return this.#directory; }
  static async recover(directory: string): Promise<NativeLease> {
    const folder = await lstat(directory), journal = await lstat(join(directory, "lease.json"));
    if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o7777) !== 0o700
      || !journal.isFile() || journal.uid !== folder.uid || journal.nlink !== 1 || (journal.mode & 0o7777) !== 0o600 || journal.size > 16384) throw new Error("RECOVERY_UNCONFIRMED");
    const data = JSON.parse(await readFile(join(directory, "lease.json"), "utf8"));
    if (!data || data.version !== 1 || Object.keys(data).sort().join(",") !== "creationPending,guard,images,owner,version,worker" || typeof data.owner !== "string" || !/^[a-f0-9-]{36}$/.test(data.owner)
      || !data.images || Object.keys(data.images).sort().join(",") !== "controller,endpoint,worker" || [data.images.worker, data.images.controller].some(value => typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))) throw new Error("RECOVERY_UNCONFIRMED");
    validateEndpoint(data.images.endpoint);
    const lease = new NativeLease(data.owner, data.images, directory);
    if (data.worker !== null) lease.#worker = workerBinding(data.worker);
    if (data.guard !== null) lease.#guard = guardBinding(data.guard, lease.#worker);
    if (![null, "worker", "guard"].includes(data.creationPending)) throw new Error("RECOVERY_UNCONFIRMED");
    lease.#creationPending = data.creationPending;
    return lease;
  }
  async beginCreation(role: "worker" | "guard"): Promise<void> { this.#creationPending = role; await this.#save(); }
  async #save(): Promise<void> {
    const temporary = join(this.#directory, `next-${randomUUID()}.json`), target = join(this.#directory, "lease.json");
    await writeFile(temporary, JSON.stringify({ version: 1, owner: this.owner, creationPending: this.#creationPending, images: this.#images, worker: this.#worker ?? null, guard: this.#guard ?? null }), { mode: 0o600, flag: "wx" });
    const file = await open(temporary, "r"); try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const directory = await open(this.#directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async bindWorker(value: unknown): Promise<void> {
    this.#worker = workerBinding(value);
    this.#creationPending = null;
    await this.#save();
  }
  async bindGuard(value: unknown): Promise<void> {
    this.#guard = guardBinding(value, this.#worker);
    this.#creationPending = null;
    await this.#save();
  }
  #command(args: readonly string[], timeoutMs = 5000): Promise<string> {
    return nativeCommand([args[0]!, "--host", this.#images.endpoint, ...args.slice(1)], timeoutMs);
  }
  async #inspect(name: string, image: string, role: "controller" | "worker" | "guard"): Promise<Metadata | undefined> {
    const found = await this.#command(["docker", "ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`]);
    if (!found) return undefined;
    if (!/^[a-f0-9]{64}$/.test(found)) throw new Error("CLEANUP_OWNERSHIP_UNCONFIRMED");
    const value: Metadata = JSON.parse(await this.#command(["docker", "inspect", found, "--format", "{{json .}}"]));
    const label = role === "controller" ? "dev.fleur.read-controller-owner" : "fleur.compatibility.runtime-owner";
    const expectedOwner = role === "controller" ? this.owner : "fleur-read-"+this.owner;
    if (value.Id !== found || value.Name !== "/"+name || value.Image !== image || value.Config.Labels[label] !== expectedOwner) throw new Error("CLEANUP_OWNERSHIP_UNCONFIRMED");
    if (role === "worker" && this.#worker && value.Id !== this.#worker.id) throw new Error("CLEANUP_OWNERSHIP_UNCONFIRMED");
    if (role === "guard" && this.#guard) {
      const bound = this.#guard;
      if (value.Id !== bound.guard || JSON.stringify(value.Config.Entrypoint) !== '["/usr/bin/python3"]'
        || JSON.stringify(value.Config.Cmd) !== JSON.stringify(["-I", "-u", "/controller/guard.py", bound.id, String(bound.pid), String(bound.deadline), bound.boot])) throw new Error("GUARD_IDENTITY_UNCONFIRMED");
    }
    return value;
  }
  async cleanup(): Promise<void> {
    // Stop creation authority first, before inspecting or removing any children.
    const manager = await this.#inspect(this.controllerName, this.#images.controller, "controller");
    // The controller may exit by itself after this inspection, and a kill of a
    // stopped container fails (#89). Its status proves nothing either way: the
    // inspection below, bound to this exact container, does.
    if (manager?.State.Running) await this.#command(["docker", "kill", "--signal", "KILL", manager.Id]).catch(() => "");
    if (manager) {
      const stopped = await this.#inspect(this.controllerName, this.#images.controller, "controller");
      if (!stopped || stopped.Id !== manager.Id || stopped.State.Running !== false || stopped.State.Pid !== 0) throw new Error("CREATION_AUTHORITY_UNCONFIRMED");
    }
    const worker = await this.#inspect(this.workerName, this.#images.worker, "worker");
    let guard = await this.#inspect(this.guardName, this.#images.controller, "guard");
    // A stopped client does not prove an accepted daemon create request ended.
    // Keep recovery evidence when its expected child has not yet been observed.
    const creationUnconfirmed = (this.#creationPending === "worker" && !worker) || (this.#creationPending === "guard" && !guard);
    if (guard && this.#guard) {
      if (guard.State.Running) await this.#command(["docker", "wait", guard.Id], 6500);
      guard = await this.#inspect(this.guardName, this.#images.controller, "guard");
      if (!guard || guard.State.Running || guard.State.Pid !== 0) throw new Error("TERMINATION_UNCONFIRMED");
      const log = await this.#command(["docker", "logs", guard.Id]);
      if (log.length > 2048) throw new Error("GUARD_EVIDENCE_UNCONFIRMED");
      const records = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      if (records.length !== 2 || records[0]?.kind !== "armed" || records[1]?.kind !== "result" || records[1]?.physical_exit_confirmed !== true) throw new Error("GUARD_EVIDENCE_UNCONFIRMED");
    }
    if (worker) {
      await this.#command(["docker", "rm", "--force", worker.Id]);
      if (await this.#inspect(this.workerName, this.#images.worker, "worker")) throw new Error("WORKER_CLEANUP_UNCONFIRMED");
    }
    // A guard is retired only after the worker is confirmed absent.
    if (guard) {
      await this.#command(["docker", "rm", "--force", guard.Id]);
      if (await this.#inspect(this.guardName, this.#images.controller, "guard")) throw new Error("GUARD_CLEANUP_UNCONFIRMED");
    }
    if (manager) {
      await this.#command(["docker", "rm", manager.Id]);
      if (await this.#inspect(this.controllerName, this.#images.controller, "controller")) throw new Error("CONTROLLER_CLEANUP_UNCONFIRMED");
    }
    if (creationUnconfirmed) throw new Error("RECOVERY_REQUIRED");
    await rm(this.#directory, { recursive: true, force: true });
  }
}
