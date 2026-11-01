import { fileURLToPath } from "node:url";
/** Own a verification tool through a pipe and a watchdog that reaps its process group. */
export async function runTool(args: readonly string[], project: string, timeoutMs: number): Promise<{ exit: number; timedOut: boolean }> {
  const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("./tool-watchdog.ts", import.meta.url)), ...args], { detached: true, cwd: project, env: { PATH: process.env.PATH, HOME: process.env.HOME, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  const ownership = child.stdin;
  let interrupted: "SIGINT" | "SIGTERM" | "SIGHUP" | undefined, timedOut = false;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map(signal => {
    const listener = () => { interrupted ??= signal; child.kill(signal); };
    process.on(signal, listener);
    return { signal, listener };
  });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
  let exit: number;
  try { exit = await child.exited; }
  finally {
    clearTimeout(timer);
    await ownership.end();
    for (const { signal, listener } of listeners) process.removeListener(signal, listener);
  }
  // Re-raise only after the watchdog has retired and reaped its owned tool.
  if (interrupted) process.kill(process.pid, interrupted);
  return { exit, timedOut };
}
