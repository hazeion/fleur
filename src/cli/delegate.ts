import { constants } from "node:os";

/** Forward ordinary interruption only to the exact child this launcher created. */
export async function runDelegated(bin: string, argv: readonly string[]): Promise<number> {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted: typeof signals[number] | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const listeners = signals.map((signal) => {
    const listener = () => {
      interrupted ??= signal;
      child?.kill(signal);
      grace ??= setTimeout(() => child?.kill("SIGKILL"), 30_000);
    };
    process.on(signal, listener);
    return { signal, listener };
  });
  try {
    child = Bun.spawn([process.execPath, bin, ...argv], { cwd: process.cwd(), env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (interrupted) child.kill(interrupted);
    const exit = await child.exited;
    const signal = interrupted ?? child.signalCode;
    return signal ? 128 + (typeof signal === "number" ? signal : constants.signals[signal]) : exit;
  } finally {
    if (grace) clearTimeout(grace);
    for (const { signal, listener } of listeners) process.removeListener(signal, listener);
  }
}
