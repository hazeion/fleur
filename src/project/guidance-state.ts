import { catalogFailure } from "../cli/catalog";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { operationReference } from "../cli/catalog";
import { generatedGuidance, offlineGuidance, regenerateGuidance, tddGuidance } from "./guidance";
import { digest, readOwned, readOptional, updatePending, type FileChange, type UpdatePath } from "./file-update";
import { recoveryReference } from "./recovery-examples";
import { releaseVersion } from "./release";
export const guidancePaths = ["AGENTS.md", "CLAUDE.md", ".agents/skills/fleur-tdd/SKILL.md", "docs/fleur.md"] as const;
export function generatedSection(text: string): string {
  const matches = [...text.matchAll(/<!-- fleur:generated:/g)];
  const start = text.indexOf("<!-- fleur:generated:start version=");
  const end = text.indexOf("<!-- fleur:generated:end -->");
  if (matches.length !== 2 || start < 0 || end < start) throw new Error("Invalid guidance markers");
  const after = end + "<!-- fleur:generated:end -->".length;
  return text.slice(start, text[after] === "\n" ? after + 1 : after);
}
export async function guidanceFiles(): Promise<Record<typeof guidancePaths[number], string>> {
  const { commands } = await import("../cli/operations");
  return { "AGENTS.md": generatedGuidance("AGENTS.md"), "CLAUDE.md": generatedGuidance("CLAUDE.md"), ".agents/skills/fleur-tdd/SKILL.md": tddGuidance, "docs/fleur.md": offlineGuidance + operationReference(commands) + recoveryReference() };
}
export function guidanceManifest(files: Record<typeof guidancePaths[number], string>): string {
  return JSON.stringify({ formatVersion: 1, fleurVersion: releaseVersion, hashes: Object.fromEntries(guidancePaths.map(path => [path, digest(path === "AGENTS.md" || path === "CLAUDE.md" ? generatedSection(files[path]) : files[path])])) }, null, 2) + "\n";
}
export async function guidancePlan(root: string): Promise<{ changes: FileChange[]; conflicts: UpdatePath[]; token: string }> {
  const files = await guidanceFiles();
  let baseline: Record<string, string> = {};
  const manifest = readOptional(root, ".fleur-guidance.json");
  try { const parsed = JSON.parse(manifest ?? "null"); if (parsed?.formatVersion === 1 && parsed.hashes !== null && typeof parsed.hashes === "object" && !Array.isArray(parsed.hashes) && Object.values(parsed.hashes).every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) baseline = parsed.hashes; } catch { /* Edited ownership metadata cannot authorize replacement. */ }
  const changes: FileChange[] = [], conflicts: UpdatePath[] = [];
  for (const path of guidancePaths) {
    const before = readOwned(root, path);
    const section = path === "AGENTS.md" || path === "CLAUDE.md" ? generatedSection(before) : before;
    const after = path === "AGENTS.md" || path === "CLAUDE.md" ? regenerateGuidance(path, before) : files[path];
    if (before !== after) {
      changes.push({ path, before, after });
      if (digest(section) !== baseline[path]) conflicts.push(path);
    }
  }
  const after = guidanceManifest(files);
  if (manifest !== after) changes.push({ path: ".fleur-guidance.json", before: manifest, after });
  if (JSON.stringify(changes).length > 512 * 1024) throw new Error("Guidance diff exceeds bound");
  return { changes, conflicts, token: digest(JSON.stringify({ version: releaseVersion, changes, conflicts })) };
}
export async function guidanceMismatch(root: string): Promise<string[]> {
  if (updatePending(root)) return [".fleur/update"];
  const files = await guidanceFiles();
  const mismatches: string[] = [];
  for (const path of guidancePaths) {
    try {
      const current = readOwned(root, path);
      if ((path === "AGENTS.md" || path === "CLAUDE.md" ? generatedSection(current) : current) !== files[path]) mismatches.push(path);
    } catch { mismatches.push(path); }
  }
  try { if (readOwned(root, ".fleur-guidance.json") !== guidanceManifest(files)) mismatches.push(".fleur-guidance.json"); } catch { mismatches.push(".fleur-guidance.json"); }
  return mismatches;
}
export async function guardGuidance(command: string, root: string) {
  // Ordinary non-Fleur directories still permit prerequisite diagnostics.
  if (!existsSync(join(root, "fleur.json"))) return null;
  const mismatches = await guidanceMismatch(root);
  return mismatches.length ? catalogFailure(command, "GUIDANCE_MISMATCH", { message: "Generated guidance differs from the pinned release. Inspect a refresh preview before resolving it.", actual: mismatches, expected: releaseVersion, actions: [{ command: "fleur docs refresh --preview", description: "Review generated changes; refresh never changes pins or packages." }] }) : null;
}
