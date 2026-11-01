import { resolve } from "node:path";
import release from "../../../package.json" with { type: "json" };
import type { CommandInput } from "../../cli/catalog";
import { failure, success, type CliOutcome } from "../../cli/result";
import { selectTarget } from "../database/target";
import { monotonicNanoseconds } from "../development/state";
import { ArtifactRefusal, verifyArtifact } from "./artifact";
import { startFailures, type SupervisorEvent } from "./protocol";

const option = (args: readonly string[], name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
function refused(code: string, detail?: ArtifactRefusal["detail"]): CliOutcome {
  const known = startFailures[code] ?? startFailures.INTERNAL_FAILURE!;
  return failure("start", known.exit, { code: code in startFailures ? code : "INTERNAL_FAILURE", message: detail?.message ?? known.message, actions: [{ command: known.command, description: known.description }], ...detail && { expected: detail.expected, actual: detail.actual } });
}
/** The foreground launcher verifies, then runs only the artifact's own supervisor. */
export async function runStart(input: CommandInput): Promise<CliOutcome> {
  let sequence = 0;
  const emit = (event: string, data: unknown) => {
    if (input.json) process.stdout.write(JSON.stringify({ formatVersion: 1, command: "start", sequence: sequence++, event, data }) + "\n");
    else if (event === "ready") process.stdout.write(`Production ready at ${String((data as { url: string }).url)}.\n`);
    else if (event === "stopped") process.stdout.write("Production stopped.\n");
  };
  const finish = (outcome: CliOutcome): CliOutcome => {
    if (!input.json && outcome.result.error) process.stdout.write(`${outcome.result.error.code}: ${outcome.result.error.message}\n`);
    emit("completed", { result: outcome.result, exitCode: outcome.exitCode });
    return { ...outcome, streamed: true };
  };
  emit("starting", { state: "starting", ready: false });
  const host = option(input.args, "--host") ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) process.stderr.write("Warning: v1 has no authentication; this application bind exposes it beyond loopback.\n");
  let root: string;
  try { ({ root } = await verifyArtifact(resolve(process.cwd(), option(input.args, "--artifact")!), release.version)); }
  catch (error) { return finish(error instanceof ArtifactRefusal ? refused(error.code, error.detail) : refused("ARTIFACT_INVALID")); }
  // Reported before Docker is touched, and again by the supervisor as its own authority check.
  try { selectTarget(true, process.env); } catch { return finish(refused("CONFIGURATION_MISSING")); }
  const deadline = monotonicNanoseconds() + BigInt(Math.ceil(input.timeoutSeconds * 1e9));
  const child = Bun.spawn([process.execPath, "--no-env-file", `${root}/supervisor/entry.js`, root, host, option(input.args, "--port") ?? "3000", deadline.toString()], { cwd: root, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const forward = (signal: typeof signals[number]) => () => child.kill(signal);
  const listeners = signals.map(signal => { const listener = forward(signal); process.on(signal, listener); return { signal, listener }; });
  let terminal: Extract<SupervisorEvent, { event: "failed" | "stopped" }> | undefined, url: string | undefined;
  try {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        const event = JSON.parse(line) as SupervisorEvent;
        if (event.event === "ready") { url = event.url; emit("ready", { state: "ready", ready: true, url: event.url, artifact: event.artifact }); }
        else terminal = event;
      }
    }
    await child.exited;
  } finally {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  }
  if (terminal?.event === "stopped") {
    emit("stopped", { state: "stopped", ready: false });
    return finish(success("start", { state: "stopped", ready: false, url: url ?? null }));
  }
  return finish(refused(terminal?.code ?? "INTERNAL_FAILURE"));
}
