import { dlopen, FFIType, ptr } from "bun:ffi";
import { failure } from "./result.ts";

// Bun loads `.env` files from the working directory into process.env before any Fleur code runs, where they cannot be
// told apart from real configuration. They never reach the C environment, so replacing this process before anything
// reads its configuration restores exactly what the caller supplied. This module must be the entry's first import.
if (!process.execArgv.includes("--no-env-file")) {
  try {
    const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", { execv: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 } });
    // Bun has already applied any --cwd, so the last --cwd pins that result rather than applying a relative one again.
    const argv = [process.execPath, "--no-env-file", ...process.execArgv, `--cwd=${process.cwd()}`, ...process.argv.slice(1)].map(value => Buffer.from(`${value}\0`));
    const pointers = new BigUint64Array(argv.length + 1);
    argv.forEach((value, index) => { pointers[index] = BigInt(ptr(value)); });
    libc.symbols.execv(ptr(argv[0]!), ptr(pointers));
  } catch { /* Refused below: never continue with an environment that may include `.env` values. */ }
  const { result, exitCode } = failure("help", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Fleur could not start without loading .env files.", actions: [{ command: "bun --no-env-file bin/fleur.ts", description: "Start the CLI with .env loading already declined." }] });
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(result)}\n` : `${result.error!.code}: ${result.error!.message}\n`);
  process.exit(exitCode);
}
