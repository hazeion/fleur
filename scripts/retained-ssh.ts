import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

export function prepareRetainedSsh() {
  const relay = spawn("python3", ["-I", resolve(import.meta.dir, "retained-ssh.py")], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, SSH_AUTH_SOCK: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined } });
  const stream = relay.stdio[3] as Readable;
  const ready = new Promise<void>((resolve, reject) => {
    let pending = "";
    const data = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      if (pending.length > 128 || (pending.includes("\n") && pending !== '{"kind":"ready"}\n')) { stream.off("data", data); reject(new Error("Owned SSH relay readiness is invalid")); }
      else if (pending === '{"kind":"ready"}\n') { stream.off("data", data); resolve(); }
    };
    stream.on("data", data); relay.once("error", () => reject(new Error("Owned SSH relay could not start"))); relay.once("close", () => reject(new Error("Owned SSH relay closed before readiness")));
  });
  ready.catch(() => {});
  let closed = false;
  const ended = new Promise<void>((resolve) => { relay.once("error", () => { closed = true; resolve(); }); relay.once("close", () => { closed = true; resolve(); }); });
  const close = async () => {
    if (closed) return;
    relay.stdin?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ended, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned idle SSH relay cleanup is unconfirmed")), 3000); })]); }
    finally { clearTimeout(timer); if (!closed) { relay.stdout?.destroy(); relay.stderr?.destroy(); stream.destroy(); relay.unref(); } }
  };
  return { relay, ready, close };
}

/** Host-only custody. The Python parent retains the actual SSH leader unreaped. */
export function startRetainedSsh(args: string[], warm = prepareRetainedSsh(), readyBarrier?: Promise<void>) {
  const relay = warm.relay;
  let pid: number | undefined; let code: number | undefined; let survivor: boolean | undefined; let exitSignal: string | null = null; let pipes = false; let owned = true;
  let requested = false; let killed = false; let attempted = false; let stop: number | undefined; let signalError: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined; let retirement: ReturnType<typeof setTimeout> | undefined;
  let readyResolve: (pid: number) => void = () => {}; let readyReject: (error: Error) => void = () => {};
  let exitResolve: (code: number) => void = () => {}; let exitReject: (error: Error) => void = () => {};
  let pipesResolve: () => void = () => {}; let pipesReject: (error: Error) => void = () => {};
  let signalReject: (error: Error) => void = () => {};
  const pidReady = new Promise<number>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const finished = new Promise<number>((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
  const closedPipes = new Promise<void>((resolve, reject) => { pipesResolve = resolve; pipesReject = reject; });
  const signalFailed = new Promise<never>((_resolve, reject) => { signalReject = reject; });
  for (const promise of [pidReady, finished, closedPipes, signalFailed]) promise.catch(() => {});
  const inventories = new Map<number, { resolve: (live: number) => void; reject: (error: Error) => void }>(); let nextId = 0;
  const fail = (error: Error) => { readyReject(error); exitReject(error); pipesReject(error); signalReject(error); for (const request of inventories.values()) request.reject(error); inventories.clear(); };
  const relayClosed = new Promise<void>((resolve) => { relay.once("error", () => { fail(new Error("Owned SSH relay could not start")); resolve(); }); relay.once("close", () => { if (owned) { owned = false; clearTimeout(escalation); fail(new Error("Owned SSH retained custody was lost")); } resolve(); }); });
  function forceKill() {
    if (!owned || !pid || killed || (code !== undefined && survivor !== true)) return;
    attempted = true;
    try { process.kill(-pid, "SIGKILL"); killed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") killed = true; else { signalError ??= new Error(`Owned SSH SIGKILL failed for ${pid}: ${String(error)}`); signalReject(signalError); } }
  }
  function sendTerm() {
    if (!owned || !pid || killed || (code !== undefined && survivor !== true)) return;
    try { process.kill(-pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") killed = true; else { signalError ??= new Error(`Owned SSH SIGTERM failed for ${pid}: ${String(error)}`); signalReject(signalError); } }
    escalation = setTimeout(forceKill, 100);
  }
  function requestTermination() {
    stop ??= performance.now() + 3000;
    if (requested) return;
    requested = true;
    retirement = setTimeout(() => signalReject(new Error("Owned SSH process group cleanup is unconfirmed")), 3000);
    sendTerm();
  }
  const write = (value: object) => { if (!relay.stdin?.writable) throw new Error("Owned SSH control channel closed"); relay.stdin.write(JSON.stringify(value) + "\n"); };
  relay.stdin?.on("error", () => { if (owned) fail(new Error("Owned SSH control channel failed")); });
  async function control() {
    let pending = ""; let records = 0;
    for await (const chunk of relay.stdio[3] as Readable) {
      pending += Buffer.from(chunk).toString("utf8");
      if (pending.length > 4096) throw new Error("Owned SSH control output exceeded its bound");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        if (++records > 1024) throw new Error("Owned SSH control record bound exceeded");
        const value = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (value.kind === "pid" && pid === undefined && Number.isSafeInteger(value.pid) && value.pid > 0) { pid = value.pid; readyResolve(pid!); if (requested) sendTerm(); }
        else if (value.kind === "status" && pid && code === undefined && Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 && (value.signal === null || (typeof value.signal === "string" && /^SIG[A-Z0-9]+$/.test(value.signal)))) { code = value.code; exitSignal = value.signal; }
        else if (value.kind === "exit" && pid && code === value.code && survivor === undefined && Number.isInteger(value.code) && value.code >= 0 && value.code <= 255 && typeof value.survivor === "boolean") { code = value.code; survivor = value.survivor; exitResolve(code!); if (survivor) { if (requested) forceKill(); else requestTermination(); } }
        else if (value.kind === "pipes" && !pipes) { pipes = true; pipesResolve(); }
        else if (value.kind === "inventory" && Number.isSafeInteger(value.id) && Number.isSafeInteger(value.live) && value.live >= 0 && inventories.has(value.id)) { inventories.get(value.id)!.resolve(value.live); inventories.delete(value.id); }
        else throw new Error(`Owned SSH custody or process inventory is unconfirmed${value.kind === "error" && typeof value.stage === "string" ? ": " + value.stage : ""}`);
      }
    }
    if (pending) throw new Error("Owned SSH control output was incomplete");
  }
  Promise.all([warm.ready, readyBarrier]).then(() => {
    control().catch((error) => fail(error instanceof Error ? error : new Error("Owned SSH control failed")));
    if (requested) { relay.stdin?.end(); fail(new Error("SSH session start was cancelled")); }
    else write({ kind: "start", args: ["ssh", ...args] });
  }).catch((error) => fail(error instanceof Error ? error : new Error("Owned SSH relay readiness failed")));
  async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned SSH process group cleanup is unconfirmed")), Math.max(1, (stop ?? performance.now() + 3000) - performance.now())); })]); }
    finally { clearTimeout(timer); }
  }
  async function inspect(): Promise<number> {
    const id = ++nextId;
    const result = new Promise<number>((resolve, reject) => inventories.set(id, { resolve, reject }));
    write({ kind: "inspect", id }); return within(result);
  }
  async function cleanup() {
    stop ??= performance.now() + 3000;
    try {
      if (code === undefined || survivor) requestTermination();
      if (attempted && !killed) forceKill();
      await within(Promise.all([finished, closedPipes]));
      while (await inspect()) { forceKill(); await within(new Promise((resolve) => setTimeout(resolve, 10))); }
      clearTimeout(escalation);
      owned = false; write({ kind: "release" }); relay.stdin!.end();
      await within(relayClosed);
      // After release/reap, the old numeric group is observation-only.
      while (pid) {
        try { process.kill(-pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
        await within(new Promise((resolve) => setTimeout(resolve, 10)));
      }
      if (signalError) throw signalError;
      if (survivor) throw new Error("A surviving owned SSH process group invalidated its completed leader");
    } catch (error) {
      if (owned) forceKill();
      owned = false; relay.stdin?.end();
      relay.stdout?.destroy(); relay.stderr?.destroy(); (relay.stdio[3] as Readable | null)?.destroy(); relay.unref();
      throw error;
    } finally { clearTimeout(escalation); clearTimeout(retirement); }
  }
  return { get signal() { return exitSignal; }, stdout: relay.stdout!, stderr: relay.stderr!, finished, pidReady, signalFailed, requestTermination, cleanup };
}
