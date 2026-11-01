import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import release from "../../package.json" with { type: "json" };
import type { Invocation } from "./main.ts";
import { failure, type CliOutcome } from "./result.ts";
export const releaseVersion = release.version;
export type ProjectPin = { readonly kind: "unconfigured" } | { readonly kind: "invalid" } | { readonly kind: "configured"; readonly root: string; readonly version: string; readonly currentCompatible: boolean };
const exactVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export async function readMetadata(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid metadata.");
    const buffer = Buffer.alloc(65537);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > 65536) throw new Error("Invalid metadata.");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally { await file.close(); }
}
export async function findProjectPin(project: string): Promise<ProjectPin> {
  let root = project;
  for (;;) {
    try {
      const metadata = await readMetadata(join(root, "fleur.json"));
      const version = metadata && typeof metadata === "object" && "fleurVersion" in metadata ? metadata.fleurVersion : undefined;
      const currentCompatible = metadata !== null && typeof metadata === "object"
        && "formatVersion" in metadata && metadata.formatVersion === 1
        && "contractVersion" in metadata && metadata.contractVersion === 1
        && "compiler" in metadata && metadata.compiler === "microsoft";
      return typeof version === "string" && version.length <= 128 && exactVersion.test(version) ? { kind: "configured", root, version, currentCompatible } : { kind: "invalid" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "invalid" };
    }
    // A release-owned application marker identifies a damaged existing project.
    // It never supplies a substitute version for the authoritative fleur.json pin.
    try {
      const manifest = await readMetadata(join(root, "package.json"));
      if (manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) && "fleur" in manifest) return { kind: "invalid" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { kind: "invalid" };
    }
    const parent = dirname(root);
    if (parent === root) return { kind: "unconfigured" };
    root = parent;
  }
}
export function invalidPin(command: string): CliOutcome {
  return failure(command, 4, { code: "VERSION_MISMATCH", message: "The project needs an exact Fleur pin before this command can run.", expected: "exact Fleur version", actual: "invalid or missing pin", actions: [{ command: "fleur doctor", description: "Inspect the project metadata and explicitly restore its intended exact Fleur version." }] });
}
export function versionMismatch(command: string, expected: string): CliOutcome {
  return failure(command, 4, { code: "VERSION_MISMATCH", message: "The project's exact Fleur release is not available through this launcher.", expected, actual: releaseVersion, actions: [{ command: "fleur doctor", description: "Install the intended exact project-local Fleur release explicitly, then retry. No package was fetched automatically." }] });
}
export function isPinIndependent(command: string): boolean { return ["help", "doctor", "setup grants list", "setup grants revoke", "start"].includes(command); }
export async function guardProjectPin(command: string, project: string): Promise<CliOutcome | null> {
  if (isPinIndependent(command)) return null;
  const pin = await findProjectPin(project);
  if (pin.kind === "invalid" || (pin.kind === "unconfigured" && !["new", "init", "setup"].includes(command))) return invalidPin(command);
  if (pin.kind === "configured" && pin.version !== releaseVersion) return versionMismatch(command, pin.version);
  if (pin.kind === "configured" && !pin.currentCompatible) return failure(command, 4, {
    code: "VERSION_MISMATCH", message: "The project contract or compiler is incompatible with this Fleur release.",
    expected: { formatVersion: 1, contractVersion: 1, compiler: "microsoft" }, actual: "incompatible or missing project contract",
    actions: [{ command: "fleur doctor", description: "Inspect and explicitly restore the metadata for the project's intended release and supported compiler." }],
  });
  return null;
}

export type LauncherDecision = { readonly kind: "current" } | { readonly kind: "blocked"; readonly outcome: CliOutcome } | { readonly kind: "delegate"; readonly bin: string };
function inside(parent: string, child: string): boolean { const path = relative(parent, child); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); }
export async function resolveProjectLauncher(invocation: Invocation, executable: string): Promise<LauncherDecision> {
  const command = invocation.handler?.name;
  const targetUpgrade = command === "upgrade" && invocation.commandArgs[invocation.commandArgs.indexOf("--to") + 1] === releaseVersion;
  if (invocation.help || !command || targetUpgrade || (command === "docs refresh" && invocation.commandArgs.length === 1 && invocation.commandArgs[0] === "--recover") || isPinIndependent(command)) return { kind: "current" };
  const pin = await findProjectPin(invocation.project);
  if (pin.kind !== "configured" || pin.version === releaseVersion) {
    const blocked = await guardProjectPin(command, invocation.project);
    return blocked ? { kind: "blocked", outcome: blocked } : { kind: "current" };
  }
  try {
    const modules = await realpath(join(pin.root, "node_modules"));
    const local = await realpath(join(modules, "fleur"));
    if (!inside(modules, local)) throw new Error("Package outside project dependencies.");
    const metadata = await readMetadata(join(local, "package.json"));
    if (!metadata || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== "fleur" || !("version" in metadata) || metadata.version !== pin.version || !("bin" in metadata)) throw new Error("Mismatched installed package.");
    const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin && typeof metadata.bin === "object" && "fleur" in metadata.bin ? metadata.bin.fleur : undefined;
    if (typeof bin !== "string" || isAbsolute(bin) || bin.length > 1024) throw new Error("Invalid executable.");
    const candidate = await realpath(resolve(local, bin));
    if (!inside(local, candidate) || !(/\.(?:[cm]?js|ts)$/.test(candidate)) || !(await lstat(candidate)).isFile() || candidate === await realpath(executable)) throw new Error("Invalid executable or delegation loop.");
    return { kind: "delegate", bin: candidate };
  } catch { return { kind: "blocked", outcome: versionMismatch(command, pin.version) }; }
}
