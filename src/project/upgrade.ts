import { catalogFailure } from "../cli/catalog";
import { failure, success, type CliOutcome } from "../cli/result";
import { applyFiles, digest, readOwned, type FileChange } from "./file-update";
import { releaseVersion, exactStableVersion } from "./release";
export { exactStableVersion } from "./release";

/** Trusted release code only. No registry metadata, project input or CLI path can supply an upgrade. */
export interface UpgradePath {
  readonly from: string;
  readonly to: string;
  readonly contractVersion: 1;
  readonly compiler: "microsoft";
  readonly breaking: boolean;
  readonly instructions: string;
  readonly changes: (root: string, signal: AbortSignal) => Promise<FileChange[]>;
  /** Source-owned compatibility checks; must never migrate/reset the database or install packages. */
  readonly check: (root: string, signal: AbortSignal) => Promise<void>;
}
// First release: there is no earlier published release, hence no documented direct edge yet.
export const supportedUpgrades: readonly UpgradePath[] = [];
export async function upgradeProject(root: string, to: string, preview: boolean, accepted?: string, paths: readonly UpgradePath[] = supportedUpgrades, deadline = Infinity): Promise<CliOutcome> {
  const metadataText = readOwned(root, "fleur.json"), manifestText = readOwned(root, "package.json");
  const metadata = JSON.parse(metadataText), manifest = JSON.parse(manifestText);
  const from: unknown = metadata.fleurVersion;
  const path = paths.find(path => path.from === from && path.to === to);
  const unsupported = () => catalogFailure("upgrade", "UPGRADE_PATH_UNSUPPORTED", { message: "No documented direct upgrade path exists for these exact releases. No files or database were changed.", expected: paths.filter(path => path.from === from).map(path => path.to), actual: to, actions: [{ command: "fleur docs upgrades", description: "Inspect supported direct paths and any required intermediate releases." }] });
  if (!path || !exactStableVersion.test(path.from) || !exactStableVersion.test(path.to) || Bun.semver.order(path.to, path.from) <= 0) return unsupported();
  const [major, minor] = path.from.split(".").map(Number), [nextMajor, nextMinor] = path.to.split(".").map(Number);
  if (major !== nextMajor || (path.breaking && (major !== 0 || nextMinor === minor || !path.instructions.trim()))) return unsupported();
  if (metadata.formatVersion !== 1 || metadata.contractVersion !== path.contractVersion || metadata.compiler !== path.compiler || manifest.fleur?.version !== from) return failure("upgrade", 4, { code: "VERSION_MISMATCH", message: "The project contract, compiler or package pin is incompatible with this upgrade.", actions: [] });
  const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
  const signal = Number.isFinite(deadline) ? AbortSignal.timeout(remaining()) : new AbortController().signal;
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let rejectAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("UPDATE_TIMEOUT")); signal.addEventListener("abort", rejectAbort, { once: true }); });
    try { return await Promise.race([work(), aborted]); } finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
  }
  try { await bounded(() => path.check(root, signal)); } catch (error) {
    return catalogFailure("upgrade", error instanceof Error && error.message === "UPDATE_TIMEOUT" ? "UPDATE_TIMEOUT" : "UPGRADE_INCOMPATIBLE", { message: "Upgrade compatibility checks did not pass; no files or database were changed.", actions: [] });
  }
  const replacements = await bounded(() => path.changes(root, signal));
  // Release paths own reviewed tooling graphs/guidance, never application source or migration files.
  if (new Set(replacements.map(change => change.path)).size !== replacements.length || replacements.some(change => change.path === "fleur.json" || change.path === "package.json")) throw new Error("Invalid release upgrade path");
  const nextManifest = { ...manifest, fleur: { ...manifest.fleur, version: to } };
  const packageFields = ["dependencies", "devDependencies"] as const;
  const installedPins = packageFields.filter(field => manifest[field]?.fleur !== undefined);
  if (installedPins.length > 1 || installedPins.some(field => manifest[field].fleur !== from) || (installedPins.length && !replacements.some(change => change.path === "bun.lock" && change.after !== change.before))) return catalogFailure("upgrade", "UPGRADE_INCOMPATIBLE", { message: "An installed Fleur transition requires its exact source pin and a reviewed target frozen lock diff." });
  for (const field of installedPins) nextManifest[field] = { ...manifest[field], fleur: to };
  const changes: FileChange[] = [...replacements, { path: "package.json", before: manifestText, after: JSON.stringify(nextManifest, null, 2) + "\n" }, { path: "fleur.json", before: metadataText, after: JSON.stringify({ ...metadata, fleurVersion: to }, null, 2) + "\n" }];
  if (changes.some(change => readOwned(root, change.path) !== change.before) || JSON.stringify(changes).length > 512 * 1024) throw new Error("Upgrade preview is stale or exceeds bounds");
  const token = digest(JSON.stringify({ changes, instructions: path.instructions, breaking: path.breaking }));
  const data = { from: String(from), to, token, breaking: path.breaking, instructions: path.instructions, changes, databaseChanged: false, rollback: "Files and exact pin only; pin rollback never reverses schema changes." };
  if (preview) return success("upgrade", data);
  if ((path.breaking && accepted !== token) || (accepted !== undefined && accepted !== token)) return catalogFailure("upgrade", "UPGRADE_REVIEW_REQUIRED", { message: "Review the preview and explicitly accept its content-bound token.", actions: [{ command: `fleur upgrade --to ${to} --preview`, description: "Read breaking-change instructions and every file diff before accepting." }] });
  const applied = await applyFiles(root, changes, () => bounded(() => path.check(root, signal)), undefined, deadline);
  return applied.ok ? success("upgrade", { from: String(from), to, databaseChanged: false }) : catalogFailure("upgrade", applied.unrestored.length ? "RECOVERY_REQUIRED" : "UPGRADE_FAILED", { message: applied.unrestored.length ? "Upgrade failed; some files could not be restored safely. The private recovery journal was retained." : "Upgrade failed; previous files and exact pin were restored. Schema changes are never reversed by pin rollback.", actual: { unrestored: applied.unrestored }, actions: [{ command: "fleur docs refresh --recover", description: "Reconcile the retained file-update journal after its owner exits." }] });
}
export const upgradeCatalog = () => ({ fleurVersion: releaseVersion, paths: supportedUpgrades.map(({ from, to, breaking, instructions }) => ({ from, to, breaking, instructions })) });
