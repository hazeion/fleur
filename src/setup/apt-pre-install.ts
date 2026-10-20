import { aptHealthArgs, healthyDpkgSnapshot } from "./apt-health.ts";
/** Standard APT protocol-v2 guard; frontend serialization, not a backend-lock claim. */
import { constants, write } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

type GuardStage = "invocation" | "plan-file" | "plan-schema" | "protocol-input" | "protocol-config" | "protocol-actions" | "package-inventory" | "package-state" | "archive-identity" | "archive-digest";
let stage: GuardStage = "invocation";
const packageNames = ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin"];
async function boundedFile(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limit)) throw new Error("Unsafe guard input");
    const bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) { const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    if (used > limit) throw new Error("Unbounded guard input");
    return { bytes: bytes.subarray(0, used), info };
  } finally { await file.close(); }
}
async function input(): Promise<string> {
  const reader = Bun.stdin.stream().getReader(); const parts: Uint8Array[] = []; let used = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; used += next.value.byteLength; if (used > 2097152) throw new Error("Unbounded APT protocol"); parts.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString("utf8");
}
async function inventory(): Promise<string> {
  const child = Bun.spawn([...aptHealthArgs], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C", LANG: "C" } });
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  const collect = async (reader: ReadableStreamDefaultReader<Uint8Array>) => { const parts: Uint8Array[] = []; let used = 0; while (true) { const next = await reader.read(); if (next.done) break; used += next.value.byteLength; if (used > 2097152) throw new Error("Unbounded package state"); parts.push(next.value); } return Buffer.concat(parts).toString("utf8"); };
  const timer = setTimeout(() => { child.kill("SIGKILL"); for (const reader of readers) void reader.cancel().catch(() => {}); }, 10000);
  try { const [stdout, stderr, status] = await Promise.all([collect(readers[0]!), collect(readers[1]!), child.exited]); if (status !== 0 || stderr.trim()) throw new Error("Package state unavailable"); return stdout; }
  finally { clearTimeout(timer); child.kill("SIGKILL"); for (const reader of readers) void reader.cancel().catch(() => {}); await child.exited; }
}
async function guard(): Promise<boolean> {
  const path = process.argv[2]; const checksum = process.argv[3];
  if (process.argv.length !== 4 || !path || !checksum || !/^[a-f0-9]{64}$/.test(checksum) || process.env.APT_HOOK_INFO_FD !== "0" || process.env.DPKG_FRONTEND_LOCKED !== "true") return false;
  stage = "plan-file";
  const loaded = await boundedFile(path, 65536);
  if ((loaded.info.mode & 0o777n) !== 0o600n || Bun.CryptoHasher.hash("sha256", loaded.bytes, "hex") !== checksum) return false;
  stage = "plan-schema";
  const value: unknown = JSON.parse(loaded.bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (Object.keys(plan).sort().join(",") !== "formatVersion,packages,present,user" || plan.formatVersion !== 1 || !Number.isSafeInteger(plan.user) || BigInt(plan.user as number) !== loaded.info.uid || !Array.isArray(plan.packages) || !plan.packages.length || plan.packages.length > 5 || plan.present === null || typeof plan.present !== "object" || Array.isArray(plan.present)) return false;
  const present = plan.present as Record<string, unknown>;
  const packages = new Map<string, Record<string, unknown>>();
  for (const item of plan.packages) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const artifact = item as Record<string, unknown>;
    if (Object.keys(artifact).sort().join(",") !== "architecture,dev,ino,name,path,sha256,size,version" || typeof artifact.name !== "string" || !packageNames.includes(artifact.name) || packages.has(artifact.name) || Object.hasOwn(present, artifact.name) || typeof artifact.version !== "string" || !/^[0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(artifact.version) || (typeof artifact.architecture !== "string" || !["amd64", "arm64"].includes(artifact.architecture)) || typeof artifact.path !== "string" || !isAbsolute(artifact.path) || resolve(artifact.path) !== artifact.path || !artifact.path.startsWith(dirname(path) + sep) || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || (artifact.size as number) <= 0 || (artifact.size as number) > 268435456 || typeof artifact.dev !== "string" || !/^[0-9]+$/.test(artifact.dev) || typeof artifact.ino !== "string" || !/^[0-9]+$/.test(artifact.ino)) return false;
    packages.set(artifact.name, artifact);
  }
  if (Object.keys(present).some((name) => !packageNames.includes(name) || typeof present[name] !== "string") || packages.size + Object.keys(present).length !== 5) return false;
  stage = "protocol-input";
  const lines = (await input()).replace(/\n$/, "").split("\n");
  if (lines.shift() !== "VERSION 2") return false;
  stage = "protocol-config";
  const config = new Map<string, string[]>();
  let separator = false;
  while (lines.length) {
    const line = lines.shift()!; if (!line) { separator = true; break; }
    const at = line.indexOf("="); if (at <= 0) return false;
    const key = decodeURIComponent(line.slice(0, at)); const value = decodeURIComponent(line.slice(at + 1));
    config.set(key, [...config.get(key) ?? [], value]);
  }
  if (!separator || !lines.length || JSON.stringify(config.get("RootDir")) !== '["/"]' || JSON.stringify(config.get("Dir::State::status")) !== '["/var/lib/dpkg/status"]' || JSON.stringify(config.get("Debug::NoLocking")) !== '["false"]') return false;
  stage = "protocol-actions";
  const installed = new Set<string>(); const configured = new Set<string>();
  for (const line of lines) {
    const action = /^(\S+) (\S+) ([<=>]) (\S+) (.+)$/.exec(line);
    if (!action) return false;
    const [, name, oldVersion, direction, newVersion, operation] = action;
    const artifact = packages.get(name!);
    if (!artifact || oldVersion !== "-" || direction !== "<" || newVersion !== artifact.version) return false;
    if (operation === "**CONFIGURE**") { if (!installed.has(name!) || configured.has(name!)) return false; configured.add(name!); continue; }
    if (operation !== artifact.path || installed.has(name!)) return false;
    installed.add(name!);
  }
  if (installed.size !== packages.size) return false;
  // Protocol v2 omits global ConfigurePending: independently reject every preexisting
  // incomplete package, trigger state or reinstreq instead of silently repairing it.
  stage = "package-inventory";
  const snapshot = healthyDpkgSnapshot(await inventory());
  if (!snapshot) return false;
  stage = "package-state";
  const retained = new Set<string>();
  for (const [name, state] of snapshot) {
    const base = name.split(":")[0]!;
    if (packages.has(base)) return false;
    if (Object.hasOwn(present, base)) { if (name !== base || state.status !== "installed" || present[base] !== state.version) return false; retained.add(base); }
  }
  if (retained.size !== Object.keys(present).length) return false;
  for (const artifact of packages.values()) {
    stage = "archive-identity";
    const file = await open(artifact.path as string, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true }); const size = artifact.size as number;
      if (!info.isFile() || info.nlink !== 1n || info.uid !== loaded.info.uid || info.dev !== BigInt(artifact.dev as string) || info.ino !== BigInt(artifact.ino as string) || info.size !== BigInt(size)) return false;
      stage = "archive-digest";
      const hash = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let used = 0;
      while (used <= size) { const read = await file.read(buffer, 0, Math.min(buffer.length, size + 1 - used)); if (!read.bytesRead) break; used += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead)); }
      if (used !== size || hash.digest("hex") !== artifact.sha256) return false;
    } finally { await file.close(); }
  }
  process.stdout.write(`[fleur-apt-guard] ${checksum}\n`);
  return true;
}
try { process.exitCode = await guard() ? 0 : 1; } catch { process.exitCode = 1; }

if (process.exitCode === 1) {
  try { write(process.stderr.fd, Buffer.from("FLEUR_APT_GUARD_REFUSAL " + JSON.stringify({ formatVersion: 1, stage }) + "\n"), () => {}); } catch { /* Diagnostic delivery cannot change the refusal. */ }
}
