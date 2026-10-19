import { closeSync, constants, fstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
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
interface DirectoryIdentity { readonly dev: bigint; readonly ino: bigint }
async function outputDirectory(path: string): Promise<{ directory: FileHandle; verify: () => Promise<void> }> {
  const ancestors = new Map<string, DirectoryIdentity>();
  for (let parent = dirname(path);;) {
    const info = await lstat(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe output ancestor.");
    ancestors.set(parent, { dev: info.dev, ino: info.ino });
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  await mkdir(path, { mode: 0o700 });
  const created = await lstat(path, { bigint: true });
  if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("Output directory changed during creation.");
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const verify = async () => {
    for (const [parent, expected] of ancestors) {
      const current = await lstat(parent, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error("Output ancestor changed; refusing publication.");
    }
    const bound = await directory.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino
      || !bound.isDirectory() || bound.dev !== created.dev || bound.ino !== created.ino || bound.uid !== BigInt(process.getuid?.() ?? -1) || (bound.mode & 0o077n) !== 0n) throw new Error("Output directory changed; refusing publication.");
  };
  try { await verify(); return { directory, verify }; }
  catch (error) { await directory.close(); throw error; }
}
async function publish(scratch: string, output: Awaited<ReturnType<typeof outputDirectory>>, expected: readonly { filename: string; sha256: string }[]) {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Descriptor-relative artifact publication is unavailable on this platform.");
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    linkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    // No O_CREAT here: the three fixed arguments avoid variadic mode ABI differences.
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  let sourceDirectory: FileHandle | undefined;
  try {
    sourceDirectory = await open(scratch, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if ((await sourceDirectory.stat({ bigint: true })).dev !== (await output.directory.stat({ bigint: true })).dev) throw new Error("Staging and output must share a filesystem; choose an owned TMPDIR on the output filesystem.");
    for (const artifact of expected) {
      await output.verify();
      const source = await open(join(scratch, artifact.filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const identity = await source.stat({ bigint: true });
        if (!identity.isFile() || identity.uid !== BigInt(process.getuid?.() ?? -1) || identity.nlink !== 1n) throw new Error("Unsafe staged artifact identity.");
        await source.sync();
        const name = Buffer.from(artifact.filename + "\0");
        if (library.symbols.linkat(sourceDirectory.fd, ptr(name), output.directory.fd, ptr(name), 0) !== 0) throw new Error("Exclusive descriptor-relative artifact publication failed.");
        const published = library.symbols.openat(output.directory.fd, ptr(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (published < 0) throw new Error("Published artifact could not be inspected without following links.");
        try {
          const actual = fstatSync(published, { bigint: true });
          if (!actual.isFile() || actual.dev !== identity.dev || actual.ino !== identity.ino || actual.size !== identity.size || hash(readFileSync(published)) !== artifact.sha256) throw new Error("Published artifact identity or bytes changed.");
        } finally { closeSync(published); }
        await output.verify();
      } finally { await source.close(); }
    }
    await output.directory.sync();
    await output.verify();
  } finally { try { await sourceDirectory?.close(); } finally { library.close(); } }
}
async function build(output: string) {
  const catalogBytes = await readFile(new URL("./native-candidate-ubuntu24-amd64.json", import.meta.url));
  if (hash(catalogBytes) !== catalogSha256) throw new Error("The source-owned candidate catalog changed; review and pin it explicitly.");
  const catalog = JSON.parse(catalogBytes.toString("utf8")) as typeof catalogShape;
  output = join(await realpath(dirname(output)), basename(output));
  const fromSource = relative(await realpath(repository), output);
  if (fromSource === "" || (fromSource !== ".." && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource))) throw new Error("Candidate output must be outside the source repository.");
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-candidate-build-"));
  let ownedOutput: Awaited<ReturnType<typeof outputDirectory>> | undefined;
  try {
    // A caller must choose a new directory. Existing archives or directories are never replaced.
    ownedOutput = await outputDirectory(output);
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
    const evidence = Buffer.from(JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(scratch, "build-evidence.json"), evidence, { flag: "wx", mode: 0o600 });
    await publish(scratch, ownedOutput, [report.ordinary, report.candidate, { filename: "build-evidence.json", sha256: hash(evidence) }]);
    await ownedOutput.verify();
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally { try { await ownedOutput?.directory.close(); } finally { await rm(scratch, { recursive: true, force: true }); } }
}
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
  process.stderr.write("Use --out <new-owned-directory>; candidate profiles are source-owned.\n");
  process.exitCode = 2;
} else {
  try { await build(resolve(args[1])); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "Internal candidate build failed") + "\n"); process.exitCode = 1; }
}
