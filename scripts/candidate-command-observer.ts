import type { SetupHost } from "../src/setup/commands.ts";
function excerpt(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, 4096);
  if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: bytes.length > end };
}
/** Internal candidate observation only; delegates the original authorized operation once. */
export function observeCandidateCommands(host: SetupHost): SetupHost {
  return { ...host, run: async (args, timeoutMs, context) => {
    const result = await host.run(args, timeoutMs, context);
    const install = args.indexOf("install");
    if (args[0] === "sudo" && args[1] === "-n" && args[2] === "apt-get" && args.includes("--simulate") && args.includes("--no-download") && install > 2 && args.slice(install + 1).length > 0 && args.slice(install + 1).every((path) => path.startsWith("/") && path.endsWith(".deb"))) {
      const stdout = excerpt(result.stdout); const stderr = excerpt(result.stderr);
      const trace = { formatVersion: 1, phase: "apt-local-archive-plan", status: result.status, exitCode: result.exitCode ?? null, terminationUnconfirmed: result.terminationUnconfirmed === true, stdout: stdout.text, stderr: stderr.text, stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated };
      try { process.stderr.write("FLEUR_NATIVE_COMMAND_OBSERVATION " + JSON.stringify(trace) + "\n"); } catch { /* Observation cannot alter the original command result. */ }
    }
    return result;
  } };
}
