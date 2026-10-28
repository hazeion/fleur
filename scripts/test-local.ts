// Local full suite: the CLI/CI and runtime Bun halves run as two concurrent
// processes, then the Python suites run whatever the Bun halves reported. CI
// runs these parts as separate jobs and does not use this script.
import { mkdir, rm } from "node:fs/promises";
import type { FileSink, Subprocess } from "bun";

const output = "test-results/local-suite";
const python = [
  "tests/runtime/review-native-controller.test.py",
  "tests/runtime/review-native-races.test.py",
  "tests/runtime/review-retained-native.test.py",
  "tests/runtime/retained-guard-binding.test.py",
  "tests/runtime/docker-api-head.test.py",
];
interface Result { name: string; code: number | null; seconds: number; summary: string[] }
const children = new Set<Subprocess>();
let interrupted: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = signal;
    for (const child of children) child.kill(signal);
  });

async function relay(stream: ReadableStream<Uint8Array>, prefix: string, log: FileSink, summary: string[]) {
  const decoder = new TextDecoder();
  let pending = "";
  const emit = (lines: string[]) => {
    for (const line of lines) {
      log.write(`${line}\n`);
      if (/^\s*\d+ (pass|fail|skip|todo)$|^Ran \d+ tests? |^\(fail\) |^(OK|FAILED)\b/.test(line) && !summary.includes(line.trim())) summary.push(line.trim());
    }
    if (lines.length > 0) process.stdout.write(lines.map(line => `${prefix} ${line}\n`).join(""));
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    emit(lines);
  }
  pending += decoder.decode();
  if (pending !== "") emit([pending]);
}

async function run(name: string, command: string[]): Promise<Result> {
  const started = performance.now();
  const log = Bun.file(`${output}/${name}.log`).writer();
  const summary: string[] = [];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.add(child);
  const prefix = `[${name}]`;
  await Promise.all([relay(child.stdout, prefix, log, summary), relay(child.stderr, prefix, log, summary)]);
  const code = await child.exited;
  children.delete(child);
  await log.end();
  return { name, code: child.signalCode === null ? code : null, seconds: (performance.now() - started) / 1000, summary };
}

// Each half writes fresh per-file durations; the output directory is cleared first so no stale timings merge in.
const bunHalf = (name: string, paths: string[]) => run(name, [process.execPath, "test", ...paths, `--timings=${output}/${name}-timings.json`, "--update-timings"]);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const results = await Promise.all([bunHalf("cli", ["tests/cli", "tests/ci"]), bunHalf("runtime", ["tests/runtime"])]);
for (const suite of python) {
  if (interrupted) break;
  results.push(await run(`python-${suite.replace(/^.*\/|\.test\.py$/g, "")}`, ["python3", suite]));
}

const failed = results.filter(result => result.code !== 0);
const lines = ["", "Local suite summary (logs and per-file timings in " + output + "/):"];
for (const result of results) {
  lines.push(`  ${result.code === 0 ? "PASS" : "FAIL"} ${result.name} (exit ${result.code ?? "signal"}, ${result.seconds.toFixed(0)}s)`);
  for (const line of result.summary) lines.push(`      ${line}`);
}
if (interrupted) lines.push(`  Interrupted by ${interrupted}; remaining parts did not run.`);
lines.push(failed.length === 0 && !interrupted ? "All parts passed." : `${failed.length} part(s) failed.`);
console.log(lines.join("\n"));
process.exit(interrupted ? (interrupted === "SIGINT" ? 130 : 143) : failed.length === 0 ? 0 : 1);
