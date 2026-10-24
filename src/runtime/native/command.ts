import { productionHost } from "../../setup/host";

// All Docker control commands use the existing bounded host process boundary.
const host = productionHost();
export async function nativeCommand(args: readonly string[], timeoutMs = 5000): Promise<string> {
  const result = await host.run(args, timeoutMs);
  if (result.status !== "completed" || result.exitCode !== 0 || result.terminationUnconfirmed || result.stdout.length > 65536) throw new Error("CONTROL_UNCONFIRMED");
  return result.stdout.trim();
}
