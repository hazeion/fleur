import { withoutRetrievalSecrets } from "../retrieval/environment";
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
  /** Absolute `performance.now()` deadline shared by every phase of the operation. */
  readonly deadline: number;
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
const ADMISSION_MS = 20_000, STARTUP_MS = 30_000, OPERATION_MS = 5000;
// A run whose effective budget, min(explicit budget, remaining deadline), is
// shorter than this fails with QUERY_TIMEOUT before any guard starts, keeping
// its slot and prepared process. Guard arming that still outlives a budget is
// retired as unadmitted only with verified identity inside the 250-ms
// tolerance. On a host where arming takes longer than this margin plus that
// tolerance, the slot is deliberately quarantined and replaced (ADR 0001).
export const ARMING_MARGIN_MS = 500;
// After a run's budget, the controller waits up to 750 ms for the guard's
// record, then up to one second each for the application and guard exec exits
// (2.75 s). Replies that can follow a deadline retirement allow that plus margin.
const RETIREMENT_MS = 5000;

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
    void child.exited.then(() => { this.lost = true; });
  }
  /** The controller client exited: this slot can never serve another operation. */
  lost = false;
  static async start(images: NativeImages): Promise<Slot> {
    const owner = randomUUID();
    const lease = await RetainedLease.create(owner, images);
    let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">>;
    try {
      child = Bun.spawn(["docker", "--host", images.endpoint, "run", "--interactive", "--name", lease.controllerName, "--label", `${executionLabel}=${owner}`,
      "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--pids-limit=64", "--pull=never",
      "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock", "--entrypoint", "/usr/bin/python3",
      images.controller, "-I", "-u", "/controller/retained_controller.py", images.worker, images.controller, owner],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...withoutRetrievalSecrets(process.env), DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined } });
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
  /** Settles when the controller client exits, for any reason. */
  get exited(): Promise<unknown> { return this.#child.exited; }
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
  /** `end` is this run's `performance.now()` deadline: `budgetMs` after the budget was computed. */
  async run(command: unknown, exchange: Exchange, budgetMs: number, end: number): Promise<ExecutionResult> {
    const prepared = this.prepared;
    if (this.state !== "idle" || !prepared || !Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > 5000) throw new Error("REQUEST_DENIED");
    this.state = "running";
    this.prepared = undefined;
    try {
      await this.#send({ kind: "run", operation: prepared.id, budgetMs, command });
      // The controller anchors its guard deadline before acknowledging the
      // run, so a deadline frame carrying what remains of this deadline now
      // keeps the guard's deadline no later than the host's, whatever the
      // transit (#75).
      const received = record(await this.#read(budgetMs + RETIREMENT_MS));
      if (received.kind !== "received" || received.operation !== prepared.id || Object.keys(received).length !== 2) this.#quarantine(received);
      const remaining = Math.min(budgetMs, Math.floor(end - performance.now()));
      // As before the run frame, too little left to arm a guard is the caller's
      // timeout: zero withholds admission and the process stays prepared.
      const value = remaining < ARMING_MARGIN_MS ? 0 : remaining;
      await this.#send({ kind: "deadline", value, operation: prepared.id });
      // The controller's arming grace and exit checks follow an expired budget.
      const guard = record(await this.#read(budgetMs + RETIREMENT_MS));
      if (value === 0 && guard.kind === "withheld" && guard.operation === prepared.id && Object.keys(guard).length === 2) {
        this.prepared = prepared;
        this.state = "idle";
        throw new ExecutionFailure("QUERY_TIMEOUT");
      }
      if (guard.kind === "failure" && Object.keys(guard).length === 6 && guard.operation === prepared.id && guard.code === "QUERY_TIMEOUT" && guard.physicalExitConfirmed === true) {
        // Arming outlived the budget: the process never passed its startup gate.
        const evidence = this.#acceptRetirement(guard.deadline, prepared.id, undefined, ["unadmitted", "cancelled", "deadline", "premature-exit"]);
        await this.lease.endOperation(prepared.id);
        this.state = "idle";
        throw new ExecutionFailure("QUERY_TIMEOUT", evidence);
      }
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
          // Application code can forge these bytes. A process that then fails
          // to exit cleanly by itself is retired by its guard, at the latest at
          // its deadline, and fails only this operation.
          const completion = record(await this.#read(budgetMs + RETIREMENT_MS));
          if (completion.kind === "failure" && Object.keys(completion).length === 6 && completion.operation === prepared.id
            && completion.code === "INTERNAL_FAILURE" && completion.physicalExitConfirmed === true) {
            const evidence = this.#acceptRetirement(completion.deadline, prepared.id, operation.process.start, ["deadline", "premature-exit"]);
            await this.lease.endOperation(prepared.id);
            this.state = "idle";
            throw new ExecutionFailure("INTERNAL_FAILURE", evidence, operation);
          }
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
  /** Quarantined slots until their removal is verified; a failed removal stays here. */
  readonly #recovering = new Set<Slot>();
  #growAfter = 0;
  #lossBackoff = 0;
  #drained = false;
  #warmUntil = 0;
  #closed = false;
  #refresh: ReturnType<typeof setInterval> | undefined;
  private constructor(images: NativeImages, capacity: number) { this.#images = images; this.#capacity = capacity; }
  /** The most slots, including starting and recovering ones, this execution holds. */
  get capacity(): number { return this.#capacity; }
  /**
   * Opening is cold startup: it returns once one retained slot is ready, so
   * container creation is reported separately and never consumed from an
   * operation deadline. Quarantined capacity is replaced in the background.
   */
  static async open(images: NativeImages, options: { capacity?: number } = {}): Promise<NativeExecution> {
    if ([images.worker, images.controller].some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new Error("Immutable images required");
    validateEndpoint(images.endpoint);
    const capacity = options.capacity ?? 4;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) throw new Error("REQUEST_DENIED");
    const execution = new NativeExecution(images, capacity);
    try {
      execution.#grow();
      await Promise.allSettled(execution.#starting);
      if (!execution.#slots.size) throw new Error("PREREQUISITE_UNAVAILABLE");
    } catch (error) {
      // Unverified cleanup outranks the startup failure itself.
      await execution.close();
      throw error;
    }
    return execution;
  }
  /** Every slot holding capacity, including quarantined slots until their removal is verified. */
  diagnostics(): { slot: string; state: SlotState; container?: string; prepared: boolean }[] {
    return [...this.#slots, ...this.#recovering].map(slot => ({ slot: slot.owner, state: slot.state, ...(slot.binding ? { container: slot.binding.worker } : {}), prepared: slot.fresh }));
  }
  #track(work: Promise<void>): void {
    const tracked = work.catch(error => { if (this.#failures.length < 100) this.#failures.push(error); else this.#failures[99] = error; });
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }
  #notify(): void { for (const wake of this.#waiters.splice(0)) wake(); }
  #retire(slot: Slot): void {
    if (!this.#slots.delete(slot)) return;
    this.#recover(slot, true);
  }
  // A quarantined slot keeps counting toward capacity until its removal is
  // verified, so replacement never outruns recovery. Unverified removal keeps
  // that capacity occupied permanently, visible in diagnostics() and reported
  // by close().
  #recover(slot: Slot, replace: boolean): void {
    this.#recovering.add(slot);
    this.#track(slot.recover().then(() => { this.#recovering.delete(slot); if (replace) this.#replace(); }).finally(() => this.#notify()));
  }
  /** Keep one retained slot available after verified recovery, retrying after any backoff. */
  #replace(): void {
    if (this.#closed || this.#slots.size || this.#starting.size || this.#occupied >= this.#capacity) return;
    const wait = this.#growAfter - performance.now();
    if (wait <= 0) { this.#grow(); return; }
    clearTimeout(this.#replacement);
    this.#replacement = setTimeout(() => { this.#replacement = undefined; this.#replace(); }, wait);
    this.#replacement.unref?.();
  }
  #replacement: ReturnType<typeof setTimeout> | undefined;
  get #occupied(): number { return this.#slots.size + this.#starting.size + this.#recovering.size; }
  #grow(): void {
    if (performance.now() < this.#growAfter) return;
    const work = Slot.start(this.#images).then(slot => {
      // A start that outlived close()'s drain was already reported there.
      if (this.#drained) { void slot.recover().catch(() => {}); return undefined; }
      // A slot that becomes ready during close is still owned: close() waits
      // for every start before its verified close of all slots.
      this.#slots.add(slot);
      // Controller loss while idle: retire now rather than at the next use,
      // backing off so a controller that keeps dying cannot churn containers.
      // A reserved slot is checked when its reservation settles.
      void slot.exited.then(() => {
        if (slot.state !== "idle" || slot.reserved || this.#closed) return;
        this.#lossBackoff = Math.min(30_000, Math.max(1000, this.#lossBackoff * 2));
        this.#growAfter = performance.now() + this.#lossBackoff;
        slot.state = "quarantined";
        this.#retire(slot);
      });
      return slot;
    }, (error: Error & { slot?: Slot }) => {
      // Back off after a failed start instead of retrying on every wakeup.
      this.#growAfter = performance.now() + 1000;
      if (error.slot) this.#recover(error.slot, false);
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
  async #acquire(deadline: number, signal?: AbortSignal): Promise<Slot> {
    for (;;) {
      if (this.#closed) throw new Error("APPLICATION_CLOSED");
      signal?.throwIfAborted();
      for (const slot of this.#slots) if (slot.state === "idle" && !slot.reserved && slot.lost) { slot.state = "quarantined"; this.#retire(slot); }
      const idle = [...this.#slots].filter(slot => slot.state === "idle" && !slot.reserved);
      const slot = idle.find(candidate => candidate.fresh) ?? idle[0];
      if (slot) { slot.reserved = true; return slot; }
      if (this.#occupied < this.#capacity) this.#grow();
      if (performance.now() >= deadline) throw new Error("QUERY_TIMEOUT");
      await new Promise<void>(resolve => {
        // A wake by timer or abort also leaves the waiter list at once.
        const wake = () => { clearTimeout(timer); signal?.removeEventListener("abort", wake); const at = this.#waiters.indexOf(wake); if (at >= 0) this.#waiters.splice(at, 1); resolve(); };
        const timer = setTimeout(wake, Math.max(1, Math.min(deadline, Math.max(this.#growAfter, performance.now() + 50)) - performance.now()));
        this.#waiters.push(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }
  /**
   * Reserve one slot holding a fresh prepared process. One operation deadline
   * covers queueing, discard, preparation and execution: the run receives only
   * the time remaining. Slot startup and recovery are background capacity work
   * with their own bounds. The reservation runs at most once. Aborting
   * `signal` while the caller still waits for a slot rejects with its reason.
   */
  async reserve(deadline = performance.now() + OPERATION_MS, signal?: AbortSignal): Promise<Reservation> {
    const queued = performance.now();
    if (!Number.isFinite(deadline) || deadline > queued + OPERATION_MS) throw new Error("REQUEST_DENIED");
    const slot = await this.#acquire(deadline, signal);
    let used = false, released = false;
    let running: Promise<unknown> | undefined;
    const settle = () => {
      slot.reserved = false;
      if (slot.state === "idle" && slot.lost) slot.state = "quarantined";
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
      if (!slot.fresh) {
        // Preparation keeps its own bound: a caller that reaches its deadline
        // gives up, but the slot stays reserved until preparation settles, so
        // a caller deadline never quarantines healthy capacity.
        const preparing = (async () => { if (slot.prepared) await slot.discard(); await slot.prepare(); })();
        running = preparing;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([preparing, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("QUERY_TIMEOUT")), Math.max(0, deadline - performance.now())); })]);
        } finally { clearTimeout(timer); }
        running = undefined;
      }
    } catch (error) { release(); throw error; }
    return {
      deadline,
      run: async (command, exchange, budgetMs = 5000) => {
        if (used || released) throw new Error("REQUEST_DENIED");
        if (this.#closed) throw new Error("APPLICATION_CLOSED");
        if (!Number.isInteger(budgetMs) || budgetMs <= 0 || budgetMs > OPERATION_MS) throw new Error("REQUEST_DENIED");
        used = true;
        const now = performance.now();
        const budget = Math.min(budgetMs, Math.floor(deadline - now));
        if (budget < ARMING_MARGIN_MS) throw new Error("QUERY_TIMEOUT");
        const work = slot.run(command, exchange, budget, now + budget);
        running = work;
        const result = await work;
        this.#lossBackoff = 0;
        return { ...result, timings: { ...result.timings, total: Math.round(performance.now() - queued) } };
      },
      release,
    };
  }
  async execute(command: unknown, exchange: Exchange, budgetMs = OPERATION_MS): Promise<ExecutionResult> {
    const reservation = await this.reserve(performance.now() + OPERATION_MS);
    try { return await reservation.run(command, exchange, budgetMs); } finally { reservation.release(); }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#refresh);
    clearTimeout(this.#replacement);
    this.#notify();
    // One bounded drain covers starting slots and running or preparing operations.
    const drain = performance.now() + 30_000;
    await Promise.race([Promise.allSettled(this.#starting), new Promise(resolve => setTimeout(resolve, 30_000))]);
    if (this.#starting.size) { this.#drained = true; this.#failures.push(new Error("STARTUP_UNSETTLED")); }
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
