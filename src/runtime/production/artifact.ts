import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { digest } from "../database/maintenance";

export const manifestName = "fleur-artifact.json";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const imageRole = z.strictObject({
  tag: z.string().regex(/^fleur-read-build-[A-Za-z0-9-]+:latest$/),
  // A saved image has one identity per daemon store: its config digest on the
  // classic store and its index entry digest on the containerd store.
  identities: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1).max(2),
});
const relativePath = z.string().min(1).max(512).refine(value => !value.startsWith("/") && !value.split("/").some(part => part === "" || part === "." || part === ".."));
const manifestSchema = z.strictObject({
  formatVersion: z.literal(1), id: hash, fleurVersion: z.string().min(1).max(128), bun: z.string().min(1).max(64), compiler: z.literal("microsoft"),
  /** Links a running start to its project for read-only status. Never a machine path. */
  project: z.string().regex(/^(?:[a-f0-9]{64}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/),
  platform: z.strictObject({ os: z.literal("linux"), architecture: z.enum(["amd64", "arm64"]) }),
  images: z.strictObject({ archive: relativePath, worker: imageRole, controller: imageRole }),
  files: z.array(z.strictObject({ path: relativePath, sha256: hash, bytes: z.number().int().nonnegative() })).min(1).max(100000),
});
export type ArtifactManifest = z.infer<typeof manifestSchema>;
export class ArtifactRefusal extends Error {
  constructor(readonly code: "ARTIFACT_INVALID" | "ARTIFACT_INCOMPATIBLE") { super(code); }
}
const invalid = () => new ArtifactRefusal("ARTIFACT_INVALID");

export function artifactIdentity(manifest: Omit<ArtifactManifest, "id">): string {
  return digest(`fleur:artifact:v1:${JSON.stringify(manifest)}`);
}
/** Regular files only, without following links. Stream the archive; it can exceed a gigabyte. */
export async function fileDigest(path: string): Promise<{ sha256: string; bytes: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("ARTIFACT_INVALID");
    const hasher = new Bun.CryptoHasher("sha256"), buffer = Buffer.alloc(1048576);
    let bytes = 0;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) return { sha256: hasher.digest("hex"), bytes };
      hasher.update(buffer.subarray(0, read.bytesRead));
      bytes += read.bytesRead;
    }
  } finally { await file.close(); }
}
async function listFiles(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(root, path));
    else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
    else throw invalid();
  }
  return found;
}
export async function artifactFiles(root: string): Promise<string[]> { return (await listFiles(root)).sort(); }

/**
 * Checks an artifact before any of its code evaluates or Docker is contacted. The
 * exact file list means nothing can be added beside the published bundles, such
 * as a dotenv file. Same-user tampering with the manifest itself stays outside
 * the supported boundary; the digests detect corruption and partial copies.
 */
export async function verifyArtifact(directory: string, fleurVersion: string): Promise<{ readonly root: string; readonly manifest: ArtifactManifest }> {
  let root: string, manifest: ArtifactManifest;
  try {
    root = await realpath(directory);
    if (!(await lstat(root)).isDirectory()) throw invalid();
    const file = await open(join(root, manifestName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16777216) throw invalid();
      text = await file.readFile("utf8");
    } finally { await file.close(); }
    manifest = manifestSchema.parse(JSON.parse(text));
    const { id, ...content } = manifest;
    if (id !== artifactIdentity(content)) throw invalid();
    if (!manifest.files.some(entry => entry.path === manifest.images.archive)) throw invalid();
    const listed = manifest.files.map(entry => entry.path).sort();
    const actual = (await artifactFiles(root)).filter(path => path !== manifestName);
    if (JSON.stringify(listed) !== JSON.stringify(actual)) throw invalid();
    // Compatibility is reported only for an artifact that is otherwise complete.
    for (const entry of manifest.files) {
      const observed = await fileDigest(join(root, entry.path));
      if (observed.sha256 !== entry.sha256 || observed.bytes !== entry.bytes) throw invalid();
    }
  } catch (error) {
    if (error instanceof ArtifactRefusal) throw error;
    throw invalid();
  }
  if (manifest.fleurVersion !== fleurVersion || manifest.bun !== Bun.version) throw new ArtifactRefusal("ARTIFACT_INCOMPATIBLE");
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "unsupported";
  if (manifest.platform.architecture !== architecture) throw new ArtifactRefusal("ARTIFACT_INCOMPATIBLE");
  return { root, manifest };
}
/** The registration key; the same project resolves to it from fleur.json on this machine. */
export function projectKey(projectId: string | undefined, root: string): string { return projectId ?? digest(`fleur:project:${root}`); }
export function productionDirectory(home: string, project: string): string {
  return join(home, ".local", "state", "fleur", "production", digest(`fleur:production:v1:${project}`));
}
