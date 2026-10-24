/** Fixed read-only guard executed by ALPM under its normal transaction lock. */
import { archPackageNames, parseArchPackageState } from "./arch-package-state.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const names: readonly string[] = archPackageNames;
async function guard(): Promise<boolean> {
  const path = process.argv[2];
  const checksum = process.argv[3];
  if (process.argv.length !== 4 || !path || !checksum || !/^[a-f0-9]{64}$/.test(checksum)) return false;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  let owner: number;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 16384) return false;
    owner = info.uid;
    const buffer = Buffer.alloc(16385);
    let used = 0;
    while (used < buffer.length) { const read = await file.read(buffer, used, buffer.length - used, used); if (read.bytesRead === 0) break; used += read.bytesRead; }
    if (used > 16384) return false;
    bytes = buffer.subarray(0, used);
  } finally { await file.close(); }
  if (Bun.CryptoHasher.hash("sha256", bytes, "hex") !== checksum) return false;
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (Object.keys(plan).sort().join(",") !== "formatVersion,missing,packages,user" || plan.formatVersion !== 1 || !Number.isSafeInteger(plan.user) || plan.user !== owner || plan.packages === null || typeof plan.packages !== "object" || Array.isArray(plan.packages) || !Array.isArray(plan.missing)) return false;
  const versions = plan.packages as Record<string, unknown>;
  if (Object.keys(versions).sort().join(",") !== names.join(",") || names.some((name) => typeof versions[name] !== "string" || !/^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(versions[name] as string)) || plan.missing.some((name) => typeof name !== "string" || !names.includes(name)) || new Set(plan.missing).size !== plan.missing.length || plan.missing.length === 0) return false;
  const input = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) { const next = await input.read(); if (next.done) break; count += next.value.byteLength; if (count > 1024) return false; chunks.push(next.value); }
  } finally { await input.cancel().catch(() => {}); }
  const targets = Buffer.concat(chunks).toString("utf8").trim().split("\n").sort();
  if (JSON.stringify(targets) !== JSON.stringify([...plan.missing].sort())) return false;
  const child = Bun.spawn(["pacman", "--query", "--", ...names], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const parts: Uint8Array[] = []; let total = 0;
    while (true) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > 4096) throw new Error("Unbounded package output"); parts.push(next.value); }
    return Buffer.concat(parts).toString("utf8");
  };
  const timer = setTimeout(() => { child.kill("SIGKILL"); for (const reader of readers) void reader.cancel().catch(() => {}); }, 10000);
  try {
    const [stdout, stderr, status] = await Promise.all([collect(readers[0]!), collect(readers[1]!), child.exited]);
    const observed = parseArchPackageState(status, stdout, stderr, versions as Record<typeof archPackageNames[number], string>);
    return observed !== null && JSON.stringify(observed.missing) === JSON.stringify([...plan.missing].sort());
  } finally { clearTimeout(timer); child.kill("SIGKILL"); for (const reader of readers) void reader.cancel().catch(() => {}); await child.exited; }
}
try { process.exitCode = await guard() ? 0 : 1; } catch { process.exitCode = 1; }
