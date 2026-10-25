import { startWorker } from "./host";
import type { NativeImages } from "./endpoint";
type Worker = Awaited<ReturnType<typeof startWorker>>;
interface Standby { readonly work: Promise<Worker>; readonly started: number; timer?: ReturnType<typeof setTimeout>; }

/** Bounded standby workers. Each still executes exactly one guarded operation. */
export class PreparedWorkers {
  readonly #images: NativeImages;
  readonly #available: Standby[] = [];
  readonly #starting = new Set<Promise<Worker>>();
  readonly #retiring = new Set<Promise<void>>();
  readonly #owned = new Set<Worker>();
  readonly #failures: unknown[] = [];
  #target = 0;
  #closed = false;
  constructor(images: NativeImages) { this.#images = images; }
  #start(): Promise<Worker> {
    const work = startWorker(this.#images).then(async worker => {
      this.#owned.add(worker);
      if (this.#closed) { await worker.close(); this.#owned.delete(worker); throw new Error("APPLICATION_CLOSED"); }
      return worker;
    });
    this.#starting.add(work);
    void work.then(() => this.#starting.delete(work), error => {
      this.#starting.delete(work);
      if (!(error instanceof Error && error.message === "APPLICATION_CLOSED")) this.#failures.push(error);
      const index = this.#available.findIndex(entry => entry.work === work);
      if (index >= 0) { clearTimeout(this.#available[index]!.timer); this.#available.splice(index, 1); }
    });
    return work;
  }
  warm(): void {
    if (this.#closed) return;
    this.#target = 4;
    while (this.#available.length + this.#retiring.size < this.#target) {
      const entry: Standby = { work: this.#start(), started: performance.now() };
      // The controller's original 30-second startup/admission deadline remains
      // unchanged. Never hand an aged standby worker to an operation.
      entry.timer = setTimeout(() => {
        const index = this.#available.indexOf(entry);
        if (index < 0) return;
        this.#available.splice(index, 1);
        const retiring = entry.work.then(async worker => { await worker.close(); this.#owned.delete(worker); });
        this.#retiring.add(retiring);
        void retiring.then(() => this.#retiring.delete(retiring), error => { if (!(error instanceof Error && error.message === "APPLICATION_CLOSED")) this.#failures.push(error); });
      }, 20_000);
      entry.timer.unref?.();
      this.#available.push(entry);
    }
  }
  async acquire(): Promise<Worker> {
    if (this.#closed) throw new Error("APPLICATION_CLOSED");
    for (;;) {
      const entry = this.#available.shift();
      if (!entry) return this.#start();
      clearTimeout(entry.timer);
      const worker = await entry.work;
      if (performance.now() - entry.started < 20_000) return worker;
      await worker.close(); this.#owned.delete(worker);
      if (this.#closed) throw new Error("APPLICATION_CLOSED");
    }
  }
  async retire(worker: Worker): Promise<void> {
    await worker.close();
    this.#owned.delete(worker);
    if (this.#target) this.warm();
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#target = 0;
    for (const entry of this.#available) clearTimeout(entry.timer);
    this.#available.length = 0;
    await Promise.allSettled(this.#starting);
    await Promise.allSettled(this.#retiring);
    await Promise.all([...this.#owned].map(async worker => { await worker.close(); this.#owned.delete(worker); }));
    if (this.#failures.length) throw new Error("WORKER_POOL_RECOVERY_REQUIRED");
  }
}
