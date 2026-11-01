/** Retire an owned detached proof process. Forced retirement is a failed graceful-shutdown proof. */
export async function stopProofProcess(child: Pick<Bun.Subprocess, "pid" | "exited" | "exitCode" | "signalCode">, signal: "SIGTERM" | "SIGINT", graceMilliseconds = 30_000): Promise<number> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([child.exited, new Promise<never>((_, reject) => { completionTimer = setTimeout(() => reject(new Error("Owned proof process has no safe signal identity or confirmed completion")), 5000); })]); }
    finally { clearTimeout(completionTimer); }
  }
  if (child.exitCode !== null || child.signalCode !== null) return await child.exited;
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([child.exited.then(exit => ({ exit })), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), graceMilliseconds); })]);
  clearTimeout(timer);
  if (result) return result.exit;
  try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  try {
    await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned proof process did not retire after SIGKILL")), 5000); })]);
  } finally { clearTimeout(timer); }
  throw new Error("Owned proof process exceeded its graceful shutdown deadline and required SIGKILL");
}

/** Stdout may remain open after its leader exits. Do not let inherited descriptors block cleanup. */
export async function finishProofOutput(work: Promise<void>, cancel: () => Promise<unknown>, milliseconds = 5000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => {
      void cancel().catch(() => {});
      reject(new Error("Owned proof output did not complete before its drain deadline"));
    }, milliseconds); })]);
  } finally { clearTimeout(timer); }
}
