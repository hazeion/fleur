import { expect, test } from "bun:test";
import { stopProofProcess, finishProofOutput } from "../../scripts/proof-process";

test("proof shutdown bounds and reaps a process that ignores graceful termination", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], { detached: true, stdout: "pipe", stderr: "ignore" });
  try {
    const reader = child.stdout.getReader(); await reader.read(); await reader.cancel();
    await expect(stopProofProcess(child, "SIGTERM", 50)).rejects.toThrow("required SIGKILL");
    expect(child.signalCode).toBe("SIGKILL");
    expect(() => process.kill(child.pid, 0)).toThrow();
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} await child.exited; }
}, 10000);

test("proof shutdown preserves a successful graceful completion", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>process.exit(0)); console.log("ready"); setInterval(()=>{},1000)'], { detached: true, stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader(); await reader.read(); await reader.cancel();
  expect(await stopProofProcess(child, "SIGTERM", 1000)).toBe(0);
});

test("an inherited output descriptor cannot block proof cleanup indefinitely", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"inherit",stderr:"ignore",stdin:"ignore"}); process.exit(0);'], { detached: true, stdout: "pipe", stderr: "ignore" });
  const reader = child.stdout.getReader();
  const drained = (async () => { while (!(await reader.read()).done) { /* Drain owned output. */ } })();
  try {
    expect(await child.exited).toBe(0);
    await expect(finishProofOutput(drained, () => reader.cancel(), 50)).rejects.toThrow("drain deadline");
    await drained;
  } finally { try { process.kill(-child.pid, "SIGKILL"); } catch {} await reader.cancel(); }
}, 10000);

test("an unavailable child identity never becomes a process-group signal target", async () => {
  const { spyOn } = await import("bun:test");
  const signal = spyOn(process, "kill").mockImplementation(() => { throw new Error("Attempted an unowned signal"); });
  try {
    expect(await stopProofProcess({ pid: -1, exited: Promise.resolve(4), exitCode: null, signalCode: null }, "SIGTERM", 20)).toBe(4);
    expect(signal).not.toHaveBeenCalled();
  } finally { signal.mockRestore(); }
});
