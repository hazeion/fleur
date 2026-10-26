import { randomUUID } from "node:crypto";
import { validatePublicValue } from "../../schema";
import { validateEndpoint, type NativeImages } from "./endpoint";
import { NativeLease } from "./lease";

const maximum = 2 * 1024 * 1024;
export class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = new Uint8Array(0);
  constructor(stream: ReadableStream<Uint8Array>) { this.#reader = stream.getReader(); }
  async #take(length: number): Promise<Uint8Array> {
    while (this.#buffer.length < length) {
      const next = await this.#reader.read();
      if (next.done) throw new Error("TRANSPORT_EOF");
      if (this.#buffer.length + next.value.length > maximum + 65540) throw new Error("FRAME_BOUND");
      const joined = new Uint8Array(this.#buffer.length + next.value.length);
      joined.set(this.#buffer); joined.set(next.value, this.#buffer.length); this.#buffer = joined;
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }
  async read(): Promise<unknown> {
    const header = await this.#take(4);
    const length = new DataView(header.buffer).getUint32(0);
    if (!length || length > maximum) throw new Error("FRAME_BOUND");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.#take(length)));
    validatePublicValue(value);
    return value;
  }
}
export function framed(value: unknown): Uint8Array {
  validatePublicValue(value);
  const data = new TextEncoder().encode(JSON.stringify(value));
  if (!data.length || data.length > maximum) throw new Error("FRAME_BOUND");
  const result = new Uint8Array(data.length + 4);
  new DataView(result.buffer).setUint32(0, data.length);
  result.set(data, 4);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REQUEST_DENIED");
  return value as Record<string, unknown>;
}
export async function startWorker(images: NativeImages) {
  if ([images.worker, images.controller].some(value => !/^sha256:[a-f0-9]{64}$/.test(value))) throw new Error("Immutable images required");
  validateEndpoint(images.endpoint);
  const owner = randomUUID(), name = `fleur-read-controller-${owner}`;
  const lease = await NativeLease.create(owner, images);
  await lease.beginCreation("worker");
  const child = Bun.spawn(["docker", "--host", images.endpoint, "run", "--interactive", "--name", name, "--label", `dev.fleur.read-controller-owner=${owner}`,
    "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--pids-limit=64", "--pull=never",
    "--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock", images.controller, images.worker, images.controller, owner],
  { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined } });
  const reader = new FrameReader(child.stdout);
  let closed = false, used = false;
  let closing: Promise<void> | undefined;
  let evidence: Readonly<Record<string, unknown>> | undefined;
  const acceptRetirement = (value: Record<string, unknown>) => {
    const proof = record(value.deadline);
    if (value.physicalExitConfirmed !== true || proof.physical_exit_confirmed !== true || !["premature-exit", "cancelled", "deadline"].includes(String(proof.outcome))
      || [proof.kill_lateness_ms, proof.physical_exit_lateness_ms].some(ms => typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > 250)) throw new Error("TERMINATION_UNCONFIRMED");
    evidence = Object.freeze({ ...proof });
  };
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      try { await child.stdin.end(); } catch { /* A dead attach process already closed its input. */ }
      const deadline = performance.now() + 8000;
      while (child.exitCode === null && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      await lease.cleanup();
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        const reapDeadline = performance.now() + 500;
        while (child.exitCode === null && performance.now() < reapDeadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (child.exitCode === null) throw new Error("ATTACH_EXIT_UNCONFIRMED");
      }
      closed = true;
    })().finally(() => { closing = undefined; });
    return closing;
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = record(await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => { startupTimer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), 30000); })]));
    if (ready.kind !== "ready" || Object.keys(ready).length !== 2) throw new Error("SOURCE_REJECTED");
    await lease.bindWorker(ready.worker);
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(startupTimer); }
  return {
    get recoveryDirectory() { return lease.recoveryDirectory; },
    get evidence() { return evidence; },
    async run(request: unknown, exchange: (request: unknown) => Promise<unknown> | unknown, budgetMs = 5000): Promise<unknown> {
      if (used || closed) throw new Error("REQUEST_DENIED");
      used = true;
      await lease.beginCreation("guard");
      child.stdin.write(framed({ budgetMs, command: request }));
      await child.stdin.flush();
      const guard = record(await reader.read());
      if (guard.kind !== "guard" || Object.keys(guard).length !== 2) throw new Error("GUARD_IDENTITY_UNCONFIRMED");
      await lease.bindGuard(guard.value);
      child.stdin.write(framed({ kind: "admit", value: null })); await child.stdin.flush();
      for (let sequence = 0; sequence <= 500; sequence++) {
        const envelope = record(await reader.read());
        if (envelope.kind === "failure" && envelope.physicalExitConfirmed === true) { acceptRetirement(envelope); throw new Error(envelope.code === "QUERY_TIMEOUT" ? "QUERY_TIMEOUT" : "INTERNAL_FAILURE"); }
        if (envelope.kind !== "worker" || Object.keys(envelope).length !== 2) throw new Error("INTERNAL_FAILURE");
        const value = record(envelope.value);
        if (value.kind === "complete" || value.kind === "failure") {
          child.stdin.write(framed({ kind: "finish", value: null })); await child.stdin.flush();
          const completion = record(await reader.read());
          if (completion.kind !== "retired" || Object.keys(completion).length !== 3) throw new Error("TERMINATION_UNCONFIRMED");
          acceptRetirement(completion);
          return value;
        }
        child.stdin.write(framed({ kind: "reply", value: await exchange(value) })); await child.stdin.flush();
      }
      throw new Error("QUERY_LIMIT");
    }, close,
  };
}
