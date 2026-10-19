import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type catalogShape from "./native-candidate-ubuntu24-amd64.json";
import { productionHost } from "../src/setup/host.ts";

const catalogSha256 = "40ba7df11ad9f28338896531cfef0a838a5f272163478394ba8a168dfd2571df";
const markerName = "internal-native-candidate.json";
const disclosure = "INTERNAL NATIVE CANDIDATE: artifact-authenticated catalog; installation evidence pending; runtime support unverified.\n";
const repository = resolve(import.meta.dir, "..");
const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
interface SourceFile { readonly path: string; readonly sha256: string }
async function files(directory: string, relative = ""): Promise<SourceFile[]> {
  const result: SourceFile[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(absolute, path));
    else if (entry.isFile() && !(await lstat(absolute)).isSymbolicLink()) result.push({ path, sha256: hash(await readFile(absolute)) });
    else throw new Error("Source archive contains a non-regular input.");
  }
  return result;
}
async function run(args: string[], cwd: string): Promise<void> {
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    const result = await productionHost().run(args, 30000);
    if (result.status !== "completed" || result.exitCode !== 0) throw new Error("Candidate packaging command failed.");
  } finally { process.chdir(previous); }
}
async function build(output: string) {
  const catalogBytes = await readFile(new URL("./native-candidate-ubuntu24-amd64.json", import.meta.url));
  if (hash(catalogBytes) !== catalogSha256) throw new Error("The source-owned candidate catalog changed; review and pin it explicitly.");
  const catalog = JSON.parse(catalogBytes.toString("utf8")) as typeof catalogShape;
  output = join(await realpath(dirname(output)), basename(output));
  const fromSource = relative(await realpath(repository), output);
  if (fromSource === "" || (fromSource !== ".." && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource))) throw new Error("Candidate output must be outside the source repository.");
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-candidate-build-"));
  try {
    // A caller must choose a new directory. Existing archives or directories are never replaced.
    await mkdir(output, { mode: 0o700 });
    const ordinary = join(scratch, "fleur-ordinary.tgz");
    await run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", ordinary], repository);
    await run(["/usr/bin/tar", "-xzf", ordinary, "-C", scratch], repository);
    const staged = join(scratch, "package");
    const sourceFiles = await files(staged);
    if (sourceFiles.some(({ path }) => path.startsWith("scripts/") || path === markerName || path === "bin/native-candidate-catalog.ts")) throw new Error("Ordinary release unexpectedly contains internal candidate tooling.");
    const ordinarySha256 = hash(await readFile(ordinary));
    const provenance = { ordinaryArchiveSha256: ordinarySha256, sourceFilesSha256: hash(Buffer.from(JSON.stringify(sourceFiles))), sourceFiles };
    const metadata = {
      formatVersion: 1, internalArtifact: true, catalogId: catalog.catalogId, catalogSha256,
      artifactAuthentication: catalog.artifactAuthentication, installationEvidence: catalog.installationEvidence, runtimeSupport: catalog.runtimeSupport,
      legacyProfileAdmission: { verified: true, meaning: "internal-catalog-admission-only" },
      provenance, authentication: catalog.authentication, artifacts: catalog.artifacts, limits: catalog.limits,
    };
    const profile = { ...catalog.profile, internalCandidateCatalogSha256: catalogSha256, installationEvidence: "pending", runtimeSupport: "unverified" };
    const entryPath = join(staged, "bin", "fleur.ts");
    const entry = await readFile(entryPath, "utf8");
    const anchor = "const handlers = [...projectCommands, ...setupCommands()];";
    if (entry.split(anchor).length !== 2) throw new Error("Unexpected release entry shape; candidate injection refused.");
    const injected = `import { productionHost } from "../src/setup/host.ts";\nimport { candidateProfiles } from "./native-candidate-catalog.ts";\nprocess.stderr.write(${JSON.stringify(disclosure)});\nconst handlers = [...projectCommands, ...setupCommands(productionHost(), candidateProfiles)];`;
    await writeFile(entryPath, entry.replace(anchor, injected));
    await writeFile(join(staged, "bin", "native-candidate-catalog.ts"), `// Internal immutable source-owned catalog; verified means admission only.\nconst profile = ${JSON.stringify(profile, null, 2)} as const;\nObject.freeze(profile.packages);\nexport const candidateProfiles = Object.freeze([Object.freeze(profile)]);\n`);
    const manifest = JSON.parse(await readFile(join(staged, "package.json"), "utf8"));
    manifest.name = "fleur-internal-native-candidate";
    manifest.private = true;
    manifest.fleurInternalNativeCandidate = { catalogId: catalog.catalogId, catalogSha256, installationEvidence: "pending", runtimeSupport: "unverified" };
    manifest.files = [...manifest.files, markerName];
    await writeFile(join(staged, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(join(staged, markerName), JSON.stringify(metadata, null, 2) + "\n");
    const candidate = join(scratch, "fleur-internal-native-candidate.tgz");
    await run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", candidate], staged);
    const report = {
      ...metadata, builder: { bun: Bun.version, revision: Bun.revision },
      ordinary: { filename: "fleur-ordinary.tgz", sha256: ordinarySha256 },
      candidate: { filename: "fleur-internal-native-candidate.tgz", sha256: hash(await readFile(candidate)) },
    };
    await copyFile(ordinary, join(output, report.ordinary.filename), constants.COPYFILE_EXCL);
    await copyFile(candidate, join(output, report.candidate.filename), constants.COPYFILE_EXCL);
    await writeFile(join(output, "build-evidence.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
  process.stderr.write("Use --out <new-owned-directory>; candidate profiles are source-owned.\n");
  process.exitCode = 2;
} else {
  try { await build(resolve(args[1])); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "Internal candidate build failed") + "\n"); process.exitCode = 1; }
}
