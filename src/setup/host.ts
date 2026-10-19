import { readFile } from "node:fs/promises";
import { machine, release } from "node:os";
import type { HostCommandResult, HostIdentity, SetupHost } from "./commands.ts";

async function identity(): Promise<HostIdentity> {
  if (process.platform === "darwin") {
    const { dlopen, FFIType, ptr, read } = await import("bun:ffi");
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    try {
      const value = new Int32Array(1);
      const size = new BigUint64Array([4n]);
      const name = Buffer.from("sysctl.proc_translated\0");
      const status = library.symbols.sysctlbyname(ptr(name), ptr(value), ptr(size), null, 0);
      const error = library.symbols.__error();
      const absent = status !== 0 && error !== null && read.i32(error) === 2;
      const translated = absent ? false : status === 0 && size[0] === 4n && (value[0] === 0 || value[0] === 1) ? value[0] === 1 : null;
      const productName = Buffer.from("kern.osproductversion\0");
      const product = Buffer.alloc(128);
      const productSize = new BigUint64Array([128n]);
      const productStatus = library.symbols.sysctlbyname(ptr(productName), ptr(product), ptr(productSize), null, 0);
      const productVersion = productStatus === 0 && productSize[0]! > 0n && productSize[0]! <= 128n ? product.toString("utf8").split("\0")[0]! : "unknown";
      const cpuName = Buffer.from("hw.cputype\0");
      const cpu = new Int32Array(1);
      const cpuSize = new BigUint64Array([4n]);
      const cpuStatus = library.symbols.sysctlbyname(ptr(cpuName), ptr(cpu), ptr(cpuSize), null, 0);
      const cpuVerified = cpuStatus === 0 && cpuSize[0] === 4n && (cpu[0]! & 0xffffff) === (process.arch === "x64" ? 7 : process.arch === "arm64" ? 12 : -1);
      const machineName = Buffer.from("kern.hostuuid\0");
      const machineValue = Buffer.alloc(128);
      const machineSize = new BigUint64Array([128n]);
      const machineStatus = library.symbols.sysctlbyname(ptr(machineName), ptr(machineValue), ptr(machineSize), null, 0);
      const uuid = machineStatus === 0 && machineSize[0]! > 0n && machineSize[0]! <= 128n ? machineValue.toString("utf8").split("\0")[0]! : "";
      const machineId = /^[a-f0-9-]{36}$/i.test(uuid) ? Bun.CryptoHasher.hash("sha256", `darwin:${uuid.toLowerCase()}`, "hex") : undefined;
      return { system: "darwin", architecture: process.arch, translated: cpuVerified ? translated : null, release: productVersion, ...(machineId ? { machineId } : {}) };
    } finally { library.close(); }
  }
  let distribution: string | undefined;
  let version = release();
  if (process.platform === "linux") {
    const data = await readFile("/etc/os-release", "utf8");
    const fields = Object.fromEntries(data.split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).replace(/^"(.*)"$/, "$1")]; }));
    distribution = fields.ID;
    version = fields.VERSION_ID ?? "rolling";
  }
  const native = machine();
  const translated = process.arch === "x64" ? native !== "x86_64" : process.arch === "arm64" ? !["arm64", "aarch64"].includes(native) : true;
  let machineId: string | undefined;
  if (process.platform === "linux") {
    try { const value = (await readFile("/etc/machine-id", "utf8")).trim(); if (/^[a-f0-9]{32}$/i.test(value)) machineId = Bun.CryptoHasher.hash("sha256", `linux:${value.toLowerCase()}`, "hex"); } catch { /* No remembered authority without stable machine identity. */ }
  }
  return { system: process.platform, architecture: process.arch, translated, release: version, ...(distribution ? { distribution } : {}), ...(machineId ? { machineId } : {}) };
}

async function run(args: readonly string[], timeoutMs: number): Promise<HostCommandResult> {
  if (timeoutMs <= 0) return { status: "timeout", stdout: "", stderr: "" };
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: args.includes("--host") ? { ...process.env, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined } : { ...process.env } }); }
  catch (error) { return { status: (error as { code?: string }).code === "ENOENT" ? "missing" : "completed", exitCode: 126, stdout: "", stderr: "Executable could not be started." }; }
  const stdout = child.stdout as ReadableStream<Uint8Array>;
  const stderr = child.stderr as ReadableStream<Uint8Array>;
  const readers = [stdout.getReader(), stderr.getReader()];
  let truncated = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        count += result.value.byteLength;
        if (count > 65536) { truncated = true; child.kill("SIGKILL"); break; }
        chunks.push(result.value);
      }
    } catch { /* Cancellation at the operation deadline is expected. */ }
    return Buffer.concat(chunks).toString("utf8");
  }
  const output = Promise.all(readers.map(collect));
  const finished = Promise.all([output, child.exited]);
  const expiry = new Promise<null>((resolve) => { timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); for (const reader of readers) void reader.cancel().catch(() => {}); resolve(null); }, timeoutMs); });
  const result = await Promise.race([finished, expiry]);
  clearTimeout(timer!);
  for (const reader of readers) void reader.cancel().catch(() => {});
  if (result === null || timedOut) return { status: "timeout", stdout: "", stderr: "" };
  const [[out, err], exitCode] = result;
  return { status: "completed", stdout: out!, stderr: err!, exitCode: truncated ? 1 : exitCode };
}

/** Construct lazily; help/argument parsing performs no host I/O. */
async function confirmHuman(plan: { readonly action: string; readonly method: string; readonly target: string; readonly checksum: string }, timeoutMs: number): Promise<"once" | "remembered" | "deny"> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || timeoutMs <= 0) return "deny";
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const reply = await terminal.question(`Authorize ${plan.action} using ${plan.method} for ${plan.target}\nPlan ${plan.checksum}\nType 'once', 'remember', or 'deny': `, { signal: AbortSignal.timeout(timeoutMs) });
    return reply === "once" ? "once" : reply === "remember" ? "remembered" : "deny";
  } catch { return "deny"; }
  finally { terminal.close(); process.stdin.pause(); }
}
export function productionHost(): SetupHost { return { host: identity, run, environment: { ...process.env }, interactive: process.stdin.isTTY === true && process.stdout.isTTY === true, confirmHuman }; }
