import { randomUUID } from "node:crypto";
import { validateEndpoint, type NativeImages } from "./endpoint";
import { FrameReader, framed } from "./host";
import { RetainedLease, executionLabel, type SlotBinding } from "./retained-lease";

export interface ExecutionResult {
  readonly value: unknown;
  readonly operation: { readonly id: string; readonly slot: string; readonly container: string; readonly process: { readonly pid: number; readonly namespacePid: number; readonly start: string } };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly timings: Readonly<Record<string, number>>;
}
export type SlotState = "starting" | "idle" | "preparing" | "running" | "quarantined" | "closing" | "closed";
type Exchange = (request: unknown) => Promise<unknown> | unknown;
export interface Reservation {
  run(command: unknown, exchange: Exchange, budgetMs?: number): Promise<ExecutionResult>;
  release(): void;
}
class ExecutionFailure extends Error {
  constructor(code: string, readonly evidence?: Readonly<Record<string, unknown>>, readonly operation?: ExecutionResult["operation"]) { super(code); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INTERNAL_FAILURE");
  return value as Record<string, unknown>;
}
const ADMISSION_MS = 20_000, STARTUP_MS = 30_000;

/** Host view of one retained slot. Its controller serializes every operation. */
class Slot {
  state: SlotState = "starting";
  /** Held by exactly one scheduler task (operation or replenishment) at a time. */
  reserved = false;
  prepared: { id: string; process: { pid: number; namespacePid: number }; at: number; timings: Record<string, number> } | undefined;
  readonly lease: RetainedLease;
  readonly #child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
  readonly #reader: FrameReader;
  binding!: SlotBinding;
  private constructor(lease: RetainedLease, child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>) {
    this.lease = lease; this.#child = child; this.#reader = new FrameReader(child.stdout);
  }
  static async start(images: NativeImages): Promise<Slot> {
    const owner = randomUUID();
    const lease = await RetainedLease.create(owner, images);
    let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
    try {
      child = Bun.spawn(["docker", "--host", images.endpoint, "run", "--interactive", "--name", lease.controllerName, "--label", `${executionLabel}=${owner}`,
      "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--pids-limit=64", "--pull=never",
      "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock", "--entrypoint", "/usr/bin/python3",
      images.controller, "-I", "-u", "/controller/retained_controller.py", images.worker, images.controller, owner],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined } });
    } catch (error) {
      // No client process exists, so no creation request reached Docker.
      await lease.abandon();
      throw error;
    }
    const slot = new Slot(lease, child);
    try {
      const ready = record(await slot.#read(STARTUP_MS));
      if (ready.kind !== "ready" || Object.keys(ready).length !== 2) throw new Error("SOURCE_REJECTED");
      slot.binding = await lease.bindSlot(ready.slot);
      slot.state = "idle";
      return slot;
    } catch (error) { slot.state = "quarantined"; throw Object.assign(error as Error, { slot }); }
  }
  get owner(): string { return this.lease.owner; }
  async #read(timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.#reader.read(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("CONTROL_TIMEOUT")), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async #send(value: unknown): Promise<void> { this.#child.stdin.write(framed(value)); await this.#child.stdin.flush(); }
  #quarantine(message: Record<string, unknown>): never {
    this.state = "quarantined";
    throw new Error(message.kind === "quarantined" ? "INTERNAL_FAILURE" : "SOURCE_REJECTED");
  }
  async prepare(timeoutMs = STARTUP_MS): Promise<void> {
    if (this.state !== "idle" || this.prepared) throw new Error("REQUEST_DENIED");
    this.state = "preparing";
    const id = randomUUID();
    // Freshness is measured from when preparation began, as the controller's
    // 30-second admission window is.
    const started = performance.now();
    try {
      await this.lease.beginOperation(id);
      await this.#send({ kind: "prepare", operation: id });
      const reply = record(await this.#read(Math.max(1, timeoutMs)));
      if (reply.kind !== "prepared" || reply.operation !== id || Object.keys(reply).length !== 4) this.#quarantine(reply);
      this.prepared = { id, process: await this.lease.bindProcess(id, reply.process), at: started, timings: { ...record(reply.timings) } as Record<string, number> };
      this.state = "idle";
    } catch (error) { this.state = "quarantined"; throw error; }
  }
  get fresh(): boolean { return Boolean(this.prepared && performance.now() - this.prepared.at < ADMISSION_MS); }
  async discard(): Promise<void> {
    const prepared = this.prepared;
    if (this.state !== "idle" || !prepared) return;
    this.state = "preparing";
    try {
      await this.#send({ kind: "discard", operation: prepared.id });
      const reply = record(await this.#read(5000));
      if (reply.kind !== "discarded" || reply.operation !== prepared.id) this.#quarantine(reply);
      this.#acceptRetirement(reply.deadline, prepared.id, undefined, ["cancelled", "deadline", "premature-exit"]);
      this.prepared = undefined;
      await this.lease.endOperation(prepared.id);
      this.state = "idle";
    } catch (error) { this.state = "quarantined"; throw error; }
  }
  #acceptRetirement(value: unknown, id: string, start: string | undefined, outcomes: readonly string[]): Readonly<Record<string, unknown>> {
    const proof = record(value);
    if (proof.kind !== "result" || proof.operation !== id || (start !== undefined && proof.start !== start) || proof.physical_exit_confirmed !== true || proof.retired !== true
      || !outcomes.includes(String(proof.outcome)) || [proof.kill_lateness_ms, proof.physical_exit_lateness_ms].some(ms => typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 250)) throw new Error("TERMINATION_UNCONFIRMED");
    return Object.freeze({ ...proof });
  }
  async run(command: unknown, exchange: Exchange, budgetMs: number): Promise<ExecutionResult> {
    const prepared = this.prepared;
    if (this.state !== "idle" || !prepared || !Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > 5000) throw new Error("REQUEST_DENIED");
    this.state = "running";
    this.prepared = undefined;
    try {
      await this.#send({ kind: "run", operation: prepared.id, budgetMs, command });
      const guard = record(await this.#read(budgetMs + 2000));
      if (guard.kind !== "guard" || Object.keys(guard).length !== 2) this.#quarantine(guard);
      const binding = await this.lease.bindGuard(prepared.id, guard.value);
      const operation = { id: prepared.id, slot: this.owner, container: this.binding.worker, process: { ...prepared.process, start: String(binding.start) } };
      await this.#send({ kind: "admit", value: null, operation: prepared.id });
      let cancelled: unknown;
      for (let sequence = 0; sequence <= 501; sequence++) {
        const envelope = record(await this.#read(budgetMs + 2000));
        if (envelope.kind === "failure" && envelope.operation === prepared.id && envelope.physicalExitConfirmed === true) {
          const evidence = this.#acceptRetirement(envelope.deadline, prepared.id, operation.process.start, ["cancelled", "deadline", "premature-exit"]);
          await this.lease.endOperation(prepared.id);
          this.state = "idle";
          if (cancelled) throw cancelled;
          throw new ExecutionFailure(envelope.code === "QUERY_TIMEOUT" ? "QUERY_TIMEOUT" : "INTERNAL_FAILURE", evidence, operation);
        }
        if (envelope.kind !== "worker" || Object.keys(envelope).length !== 2 || cancelled) this.#quarantine(envelope);
        const value = record(envelope.value);
        if (value.kind === "complete" || value.kind === "failure") {
          await this.#send({ kind: "finish", value: null, operation: prepared.id });
          const completion = record(await this.#read(3000));
          if (completion.kind !== "retired" || completion.operation !== prepared.id || completion.physicalExitConfirmed !== true) this.#quarantine(completion);
          const evidence = this.#acceptRetirement(completion.deadline, prepared.id, operation.process.start, ["premature-exit"]);
          await this.lease.endOperation(prepared.id);
          this.state = "idle";
          return { value, operation, evidence, timings: { ...prepared.timings, ...record(completion.timings) } as Record<string, number> };
        }
        let reply: unknown;
        try { reply = await exchange(value); }
        catch (error) {
          // Any non-reply decision cancels this operation's own process.
          cancelled = error;
          await this.#send({ kind: "cancel", value: null, operation: prepared.id });
          continue;
        }
        await this.#send({ kind: "reply", value: reply, operation: prepared.id });
      }
      throw new Error("QUERY_LIMIT");
    } catch (error) {
      if (this.state === "running") this.state = "quarantined";
      throw error;
    }
  }
  /** Verified close: the controller retires its process and containers first. */
  async close(): Promise<void> {
    if (this.state !== "idle") throw new Error("REQUEST_DENIED");
    this.state = "closing";
    try {
      await this.#child.stdin.end();
      const reply = record(await this.#read(15_000));
      if (reply.kind !== "closed") this.#quarantine(reply);
      const exited = await Promise.race([this.#child.exited, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
      if (exited !== 0) throw new Error("CONTROLLER_EXIT_UNCONFIRMED");
      await this.lease.release();
      this.state = "closed";
    } catch (error) { this.state = "quarantined"; throw error; }
  }
  #recovering: Promise<void> | undefined;
  /** Quarantine is terminal for this slot: verified removal is its recovery. */
  recover(): Promise<void> { return this.#recovering ??= this.#recover(); }
  async #recover(): Promise<void> {
    try { this.#child.stdin.end(); } catch { /* The controller may already be gone. */ }
    await this.lease.cleanup();
    if (this.#child.exitCode === null) {
      this.#child.kill("SIGKILL");
      const deadline = performance.now() + 1000;
      while (this.#child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      if (this.#child.exitCode === null) throw new Error("ATTACH_EXIT_UNCONFIRMED");
    }
    this.state = "closed";
  }
}

/**
 * Native execution beneath ReadApplication. Callers receive results only:
 * slot ownership, preparation, scheduling, cancellation, quarantine and
 * recovery stay here, so no caller decides when a container is safe to reuse.
 */
export class NativeExecution {
  readonly #images: NativeImages;
  readonly #capacity: number;
  readonly #slots = new Set<Slot>();
  readonly #starting = new Set<Promise<Slot | undefined>>();
  readonly #background = new Set<Promise<void>>();
  readonly #waiters: (() => void)[] = [];
  readonly #failures: unknown[] = [];
  #recovering = 0;
  #growAfter = 0;
  #warmUntil = 0;
  #closed = false;
  #refresh: ReturnType<typeof setInterval> | undefined;
  private constructor(images: NativeImages, capacity: number) { this.#images = images; this.#capacity = capacity; }
  static open(images: NativeImages, options: { capacity?: number } = {}): NativeExecution {
    if ([images.worker, images.controller].some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new Error("Immutable images required");
    validateEndpoint(images.endpoint);
    const capacity = options.capacity ?? 4;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new Error("REQUEST_DENIED");
    return new NativeExecution(images, capacity);
  }
  diagnostics(): { slot: string; state: SlotState; container?: string; prepared: boolean }[] {
    return [...this.#slots].map(slot => ({ slot: slot.owner, state: slot.state, ...(slot.binding ? { container: slot.binding.worker } : {}), prepared: slot.fresh }));
  }
  #track(work: Promise<void>): void {
    const tracked = work.catch(error => { this.#failures.push(error); });
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }
  #notify(): void { for (const wake of this.#waiters.splice(0)) wake(); }
  // A quarantined slot keeps counting toward capacity until its removal is
  // verified, so replacement never outruns recovery.
  #retire(slot: Slot): void {
    if (!this.#slots.delete(slot)) return;
    this.#recovering++;
    this.#track(slot.recover().finally(() => { this.#recovering--; this.#notify(); }));
  }
  get #occupied(): number { return this.#slots.size + this.#starting.size + this.#recovering; }
  #grow(): void {
    if (performance.now() < this.#growAfter) return;
    const work = Slot.start(this.#images).then(slot => {
      if (this.#closed) { this.#retire(slot); return undefined; }
      this.#slots.add(slot);
      return slot;
    }, (error: Error & { slot?: Slot }) => {
      // Back off after a failed start instead of retrying on every wakeup.
      this.#growAfter = performance.now() + 1000;
      if (error.slot) {
        this.#recovering++;
        this.#track(error.slot.recover().finally(() => { this.#recovering--; this.#notify(); }));
      }
      else if (this.#failures.length < 100) this.#failures.push(error);
      return undefined;
    });
    this.#starting.add(work);
    void work.finally(() => { this.#starting.delete(work); this.#notify(); });
  }
  /** Keep prepared fresh processes while views are active. Each still runs one operation. */
  warm(): void {
    if (this.#closed) return;
    this.#warmUntil = performance.now() + 30_000;
    while (this.#occupied < this.#capacity && performance.now() >= this.#growAfter) this.#grow();
    for (const slot of this.#slots) this.#replenish(slot);
    if (!this.#refresh) {
      this.#refresh = setInterval(() => {
        if (performance.now() > this.#warmUntil) { clearInterval(this.#refresh); this.#refresh = undefined; return; }
        for (const slot of this.#slots) this.#replenish(slot);
      }, 1000);
      this.#refresh.unref?.();
    }
  }
  #replenish(slot: Slot): void {
    if (this.#closed || slot.state !== "idle" || slot.reserved) return;
    if (slot.prepared && slot.fresh) return;
    slot.reserved = true;
    this.#track((async () => {
      try {
        // Never hand an aged prepared process to an operation.
        if (slot.prepared) await slot.discard();
        if (slot.state === "idle" && !slot.prepared && !this.#closed) await slot.prepare();
      } catch {
        // Quarantine: only an unverified recovery is reported as a failure.
        this.#retire(slot);
      } finally { slot.reserved = false; this.#notify(); }
    })());
  }
  async #acquire(deadline: number): Promise<Slot> {
    for (;;) {
      if (this.#closed) throw new Error("APPLICATION_CLOSED");
      const idle = [...this.#slots].filter(slot => slot.state === "idle" && !slot.reserved);
      const slot = idle.find(candidate => candidate.fresh) ?? idle[0];
      if (slot) { slot.reserved = true; return slot; }
      if (this.#occupied < this.#capacity) this.#grow();
      if (performance.now() >= deadline) throw new Error("QUERY_TIMEOUT");
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(1, Math.min(deadline, Math.max(this.#growAfter, performance.now() + 50)) - performance.now()));
        this.#waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
  /**
   * Reserve one slot holding a fresh prepared process. Startup and admission
   * keep their original 30-second bound; an operation's own deadline begins
   * when its bound guard is armed. The reservation runs at most once.
   */
  async reserve(): Promise<Reservation> {
    const queued = performance.now();
    const slot = await this.#acquire(queued + STARTUP_MS);
    let used = false, released = false;
    let running: Promise<unknown> | undefined;
    const settle = () => {
      slot.reserved = false;
      if (slot.state === "idle") { this.#notify(); if (performance.now() <= this.#warmUntil) this.#replenish(slot); }
      else if (slot.state === "quarantined") this.#retire(slot);
    };
    const release = () => {
      if (released) return;
      released = true;
      // A caller may give up (for example at its broker deadline) while the
      // operation still runs. The slot stays reserved until that run settles.
      if (running) void running.then(settle, settle);
      else settle();
    };
    try {
      // Acquisition, discard and preparation share one 30-second bound.
      if (!slot.fresh) {
        if (slot.prepared) await slot.discard();
        const remaining = queued + STARTUP_MS - performance.now();
        if (remaining <= 0) throw new Error("QUERY_TIMEOUT");
        await slot.prepare(remaining);
      }
    } catch (error) { release(); throw error; }
    return {
      run: async (command, exchange, budgetMs = 5000) => {
        if (used || released) throw new Error("REQUEST_DENIED");
        if (this.#closed) throw new Error("APPLICATION_CLOSED");
        used = true;
        const work = slot.run(command, exchange, budgetMs);
        running = work;
        const result = await work;
        return { ...result, timings: { ...result.timings, total: Math.round(performance.now() - queued) } };
      },
      release,
    };
  }
  async execute(command: unknown, exchange: Exchange, budgetMs = 5000): Promise<ExecutionResult> {
    const reservation = await this.reserve();
    try { return await reservation.run(command, exchange, budgetMs); } finally { reservation.release(); }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#refresh);
    this.#notify();
    // One bounded drain covers starting slots and running or preparing operations.
    const drain = performance.now() + 30_000;
    await Promise.race([Promise.allSettled(this.#starting), new Promise(resolve => setTimeout(resolve, 30_000))]);
    while ([...this.#slots].some(slot => slot.reserved || (slot.state !== "idle" && slot.state !== "quarantined")) && performance.now() < drain) await new Promise(resolve => setTimeout(resolve, 20));
    while (this.#background.size) await Promise.allSettled(this.#background);
    await Promise.all([...this.#slots].map(async slot => {
      try { if (slot.state === "idle") { await slot.close(); return; } }
      catch { /* An unverified close falls through to quarantine recovery. */ }
      await slot.recover();
    }).map(work => work.catch(error => { this.#failures.push(error); })));
    this.#slots.clear();
    while (this.#background.size) await Promise.allSettled(this.#background);
    if (this.#failures.length) throw new Error("EXECUTION_RECOVERY_REQUIRED");
  }
}
