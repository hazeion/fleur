import { mkdtemp, writeFile, rename, rm, open, readFile, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateEndpoint, type NativeImages } from "./endpoint";
import { nativeCommand } from "./command";

type Metadata = { Id: string; Name: string; Image: string; State: { Running: boolean; Pid: number }; Config: { Labels: Record<string, string> } };
export interface SlotBinding { worker: string; init: number; guard: string; boot: string; }
export interface OperationRecord { id: string; process?: { pid: number; namespacePid: number }; guard?: Record<string, unknown>; }
const hex = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9-]{36}$/;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 1;
export const executionLabel = "dev.fleur.execution-owner";

export function slotBinding(value: unknown): SlotBinding {
  const data = value as Partial<SlotBinding> | null;
  if (!data || typeof data !== "object" || Object.keys(data).length !== 4 || typeof data.worker !== "string" || !hex.test(data.worker) || !integer(data.init)
    || typeof data.guard !== "string" || !hex.test(data.guard) || data.guard === data.worker || typeof data.boot !== "string" || !uuid.test(data.boot)) throw new Error("SLOT_IDENTITY_UNCONFIRMED");
  return { worker: data.worker, init: data.init, guard: data.guard, boot: data.boot };
}

/**
 * Durable ownership of one retained slot. Container ownership is recorded
 * separately from each operation's identity, so recovery can distinguish a
 * creation intent, a prepared process and a guard-bound application entry.
 */
export class RetainedLease {
  readonly owner: string;
  readonly controllerName: string;
  readonly workerName: string;
  readonly guardName: string;
  readonly #directory: string;
  readonly #images: NativeImages;
  #creationPending: "slot" | null = null;
  #slot: SlotBinding | undefined;
  #operation: OperationRecord | undefined;
  private constructor(owner: string, images: NativeImages, directory: string) {
    this.owner = owner; this.#images = images; this.#directory = directory;
    this.controllerName = `fleur-exec-controller-${owner}`;
    this.workerName = `fleur-exec-${owner}-worker`;
    this.guardName = `fleur-exec-${owner}-guard`;
  }
  static async create(owner: string, images: NativeImages): Promise<RetainedLease> {
    validateEndpoint(images.endpoint);
    const lease = new RetainedLease(owner, images, await mkdtemp(join(tmpdir(), "fleur-retained-lease-")));
    lease.#creationPending = "slot";
    await lease.#save();
    return lease;
  }
  static async recover(directory: string): Promise<RetainedLease> {
    const folder = await lstat(directory), journal = await lstat(join(directory, "lease.json"));
    if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o7777) !== 0o700
      || !journal.isFile() || journal.uid !== folder.uid || journal.nlink !== 1 || (journal.mode & 0o7777) !== 0o600 || journal.size > 16384) throw new Error("RECOVERY_UNCONFIRMED");
    const data = JSON.parse(await readFile(join(directory, "lease.json"), "utf8"));
    if (!data || data.version !== 1 || Object.keys(data).sort().join(",") !== "creationPending,images,operation,owner,slot,version" || typeof data.owner !== "string" || !uuid.test(data.owner)
      || !data.images || Object.keys(data.images).sort().join(",") !== "controller,endpoint,worker" || [data.images.worker, data.images.controller].some(value => typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value))
      || ![null, "slot"].includes(data.creationPending)) throw new Error("RECOVERY_UNCONFIRMED");
    validateEndpoint(data.images.endpoint);
    const lease = new RetainedLease(data.owner, data.images, directory);
    lease.#creationPending = data.creationPending;
    if (data.slot !== null) lease.#slot = slotBinding(data.slot);
    if (data.operation !== null) {
      if (!data.operation || typeof data.operation.id !== "string" || !uuid.test(data.operation.id)) throw new Error("RECOVERY_UNCONFIRMED");
      lease.#operation = data.operation;
    }
    return lease;
  }
  get recoveryDirectory(): string { return this.#directory; }
  get slot(): SlotBinding | undefined { return this.#slot; }
  async #save(): Promise<void> {
    const temporary = join(this.#directory, `next-${randomUUID()}.json`), target = join(this.#directory, "lease.json");
    await writeFile(temporary, JSON.stringify({ version: 1, owner: this.owner, creationPending: this.#creationPending, images: this.#images, slot: this.#slot ?? null, operation: this.#operation ?? null }), { mode: 0o600, flag: "wx" });
    const file = await open(temporary, "r"); try { await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    const directory = await open(this.#directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  async bindSlot(value: unknown): Promise<SlotBinding> {
    this.#slot = slotBinding(value);
    this.#creationPending = null;
    await this.#save();
    return this.#slot;
  }
  /** Records process creation intent before the controller may create it. */
  async beginOperation(id: string): Promise<void> {
    if (!this.#slot || this.#operation || !uuid.test(id)) throw new Error("REQUEST_DENIED");
    this.#operation = { id };
    await this.#save();
  }
  async bindProcess(id: string, value: unknown): Promise<{ pid: number; namespacePid: number }> {
    const data = value as { pid?: unknown; namespacePid?: unknown } | null;
    if (this.#operation?.id !== id || this.#operation.process || !data || Object.keys(data).length !== 2 || !integer(data.pid) || !integer(data.namespacePid) || data.pid === this.#slot?.init) throw new Error("PROCESS_IDENTITY_UNCONFIRMED");
    this.#operation = { id, process: { pid: data.pid, namespacePid: data.namespacePid } };
    await this.#save();
    return this.#operation.process!;
  }
  async bindGuard(id: string, value: unknown): Promise<Record<string, unknown>> {
    const slot = this.#slot, operation = this.#operation, data = value as Record<string, unknown> | null;
    if (!slot || !operation?.process || operation.id !== id || operation.guard || !data || typeof data !== "object"
      || Object.keys(data).sort().join(",") !== "boot,deadline,guard,guardExec,init,namespacePid,operation,pid,start,worker"
      || data.operation !== id || data.worker !== slot.worker || data.init !== slot.init || data.guard !== slot.guard || data.boot !== slot.boot
      || data.pid !== operation.process.pid || data.namespacePid !== operation.process.namespacePid || typeof data.guardExec !== "string" || !hex.test(data.guardExec)
      || typeof data.start !== "string" || !/^[0-9]{1,20}$/.test(data.start) || typeof data.deadline !== "number" || !Number.isFinite(data.deadline) || data.deadline <= 0) throw new Error("GUARD_IDENTITY_UNCONFIRMED");
    this.#operation = { ...operation, guard: { ...data } };
    await this.#save();
    return this.#operation.guard!;
  }
  /** Called only after the controller reports verified retirement. */
  async endOperation(id: string): Promise<void> {
    if (this.#operation?.id !== id) throw new Error("REQUEST_DENIED");
    this.#operation = undefined;
    await this.#save();
  }
  #command(args: readonly string[], timeoutMs = 5000): Promise<string> {
    return nativeCommand([args[0]!, "--host", this.#images.endpoint, ...args.slice(1)], timeoutMs);
  }
  async #inspect(name: string, image: string, expected?: string): Promise<Metadata | undefined> {
    const found = await this.#command(["docker", "ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`]);
    if (!found) return undefined;
    if (!hex.test(found)) throw new Error("CLEANUP_OWNERSHIP_UNCONFIRMED");
    const value: Metadata = JSON.parse(await this.#command(["docker", "inspect", found, "--format", "{{json .}}"]));
    if (value.Id !== found || value.Name !== "/"+name || value.Image !== image || value.Config.Labels[executionLabel] !== this.owner || (expected && value.Id !== expected)) throw new Error("CLEANUP_OWNERSHIP_UNCONFIRMED");
    return value;
  }
  /** Only for a slot whose controller client never started. */
  async abandon(): Promise<void> {
    if (this.#slot || this.#operation) throw new Error("REQUEST_DENIED");
    await rm(this.#directory, { recursive: true, force: true });
  }
  /** Retires the controller's container only after it exited by itself. */
  async release(): Promise<void> {
    const manager = await this.#inspect(this.controllerName, this.#images.controller);
    if (manager?.State.Running) throw new Error("CREATION_AUTHORITY_UNCONFIRMED");
    if (await this.#inspect(this.workerName, this.#images.worker) || await this.#inspect(this.guardName, this.#images.controller)) throw new Error("WORKER_CLEANUP_UNCONFIRMED");
    if (manager) await this.#command(["docker", "rm", manager.Id]);
    if (await this.#inspect(this.controllerName, this.#images.controller)) throw new Error("CONTROLLER_CLEANUP_UNCONFIRMED");
    await rm(this.#directory, { recursive: true, force: true });
  }
  /** Quarantine recovery: stop creation authority, then the application container, then its guard. */
  async cleanup(): Promise<void> {
    const manager = await this.#inspect(this.controllerName, this.#images.controller);
    // A quarantined controller removes its own containers and exits by itself,
    // possibly after this inspection (#89), and a kill of a stopped container
    // fails. Its status proves nothing either way: the inspection below does.
    if (manager?.State.Running) await this.#command(["docker", "kill", "--signal", "KILL", manager.Id]).catch(() => "");
    if (manager) {
      const stopped = await this.#inspect(this.controllerName, this.#images.controller);
      if (!stopped || stopped.State.Running !== false || stopped.State.Pid !== 0) throw new Error("CREATION_AUTHORITY_UNCONFIRMED");
    }
    const worker = await this.#inspect(this.workerName, this.#images.worker, this.#slot?.worker);
    const guard = await this.#inspect(this.guardName, this.#images.controller, this.#slot?.guard);
    // A stopped client does not prove an accepted daemon create request ended.
    const creationUnconfirmed = this.#creationPending === "slot" && (!worker || !guard);
    if (worker) {
      await this.#command(["docker", "rm", "--force", worker.Id]);
      if (await this.#inspect(this.workerName, this.#images.worker)) throw new Error("WORKER_CLEANUP_UNCONFIRMED");
    }
    // Removing the application container retired every operation process, so
    // its guard host container can be retired next.
    if (guard) {
      await this.#command(["docker", "rm", "--force", guard.Id]);
      if (await this.#inspect(this.guardName, this.#images.controller)) throw new Error("GUARD_CLEANUP_UNCONFIRMED");
    }
    if (manager) {
      await this.#command(["docker", "rm", manager.Id]);
      if (await this.#inspect(this.controllerName, this.#images.controller)) throw new Error("CONTROLLER_CLEANUP_UNCONFIRMED");
    }
    if (creationUnconfirmed) throw new Error("RECOVERY_REQUIRED");
    await rm(this.#directory, { recursive: true, force: true });
  }
}
