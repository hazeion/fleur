import { closeSync, constants, fstatSync, fsyncSync, readFileSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type catalogShape from "./native-candidate-ubuntu24-amd64.json";
import { productionHost } from "../src/setup/host.ts";

const defaultCatalogSha256 = "540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58";
const markerName = "internal-native-candidate.json";
const catalogName = "internal-native-candidate-catalog.json";
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
async function outputDirectory(path: string) {
  const ancestors = new Map<string, DirectoryIdentity>();
  for (let parent = dirname(path);;) {
    const info = await lstat(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe output ancestor.");
    ancestors.set(parent, { dev: info.dev, ino: info.ino });
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Descriptor-relative output creation is unavailable on this platform.");
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    // Open an already-created directory: no variadic mode argument or path fallback.
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  let parent: FileHandle | undefined;
  let descriptor = -1;
  try {
    parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const expected = ancestors.get(dirname(path))!;
    const boundParent = await parent.stat({ bigint: true });
    if (!boundParent.isDirectory() || boundParent.dev !== expected.dev || boundParent.ino !== expected.ino) throw new Error("Output parent changed; refusing creation.");
    const name = Buffer.from(basename(path) + "\0");
    // Every mutation is relative to the approved parent descriptor, even if its path moves.
    if (library.symbols.mkdirat(parent.fd, ptr(name), 0o700) !== 0) throw new Error("Exclusive descriptor-relative output creation failed.");
    descriptor = library.symbols.openat(parent.fd, ptr(name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (descriptor < 0) throw new Error("Created output directory could not be opened without following links.");
    const fd = descriptor;
    const directory = {
      fd,
      stat: () => fstatSync(fd, { bigint: true }),
      sync: () => fsyncSync(fd),
      close: () => closeSync(fd),
    };
    const created = directory.stat();
    const verify = async () => {
      for (const [ancestor, identity] of ancestors) {
        const current = await lstat(ancestor, { bigint: true });
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("Output ancestor changed; refusing publication.");
      }
      const bound = directory.stat();
      const current = await lstat(path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino
        || !bound.isDirectory() || bound.dev !== created.dev || bound.ino !== created.ino || bound.uid !== BigInt(process.getuid?.() ?? -1) || (bound.mode & 0o077n) !== 0n) throw new Error("Output directory changed; refusing publication.");
    };
    await verify();
    descriptor = -1;
    return { directory, verify };
  } finally {
    try { if (descriptor >= 0) closeSync(descriptor); }
    finally { try { await parent?.close(); } finally { library.close(); } }
  }
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
    if ((await sourceDirectory.stat({ bigint: true })).dev !== output.directory.stat().dev) throw new Error("Staging and output must share a filesystem; choose an owned TMPDIR on the output filesystem.");
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
async function build(output: string, fixture: "ubuntu24-amd64" | "ubuntu26-amd64" = "ubuntu24-amd64") {
  const catalogSha256 = fixture === "ubuntu24-amd64" ? defaultCatalogSha256 : "e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a";
  const catalogBytes = await readFile(new URL(fixture === "ubuntu24-amd64" ? "./native-candidate-ubuntu24-amd64.json" : "./native-candidate-ubuntu26-amd64.json", import.meta.url));
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
    // GNU tar resolves gzip through PATH, unlike macOS libarchive. Decode with
    // the already selected Bun runtime so isolated callers need no extra tool.
    const ordinaryTar = join(scratch, "fleur-ordinary.tar");
    await writeFile(ordinaryTar, Bun.gunzipSync(await readFile(ordinary)), { flag: "wx", mode: 0o600 });
    await run(["/usr/bin/tar", "-xf", ordinaryTar, "-C", scratch], repository);
    const staged = join(scratch, "package");
    const sourceFiles = await files(staged);
    if (sourceFiles.some(({ path }) => path.startsWith("scripts/") || path === markerName || path === catalogName || path === "bin/native-candidate-catalog.ts")) throw new Error("Ordinary release unexpectedly contains internal candidate tooling.");
    const ordinarySha256 = hash(await readFile(ordinary));
    const provenance = { ordinaryArchiveSha256: ordinarySha256, sourceFilesSha256: hash(Buffer.from(JSON.stringify(sourceFiles))), sourceFiles };
    const metadata = {
      formatVersion: 1, internalArtifact: true, catalogId: catalog.catalogId, catalogSha256,
      artifactAuthentication: catalog.artifactAuthentication, installationEvidence: catalog.installationEvidence, runtimeSupport: catalog.runtimeSupport,
      legacyProfileAdmission: { verified: true, meaning: "internal-catalog-admission-only" },
      provenance, authentication: catalog.authentication, artifacts: catalog.artifacts, limits: catalog.limits,
    };
    const artifacts = Object.fromEntries(catalog.artifacts.map(({ name, version, url, sha256, size }) => [name, { name, version, architecture: catalog.profile.architecture === "x64" ? "amd64" : "arm64", url, sha256, size }]));
    const profile = { ...catalog.profile, artifacts, internalCandidateCatalogSha256: catalogSha256, installationEvidence: "pending", runtimeSupport: "unverified" };
    const entryPath = join(staged, "bin", "fleur.ts");
    const entry = await readFile(entryPath, "utf8");
    const anchor = "const handlers = [...projectCommands, ...setupCommands()];";
    if (entry.split(anchor).length !== 2) throw new Error("Unexpected release entry shape; candidate injection refused.");
    const injected = `import { productionHost } from "../src/setup/host.ts";\nimport { observeCandidateCommands } from "./candidate-command-observer.ts";\nimport { candidateProfiles } from "./native-candidate-catalog.ts";\nprocess.stderr.write(${JSON.stringify(disclosure)});\nconst handlers = [...projectCommands, ...setupCommands(observeCandidateCommands(observeCandidateCommands(productionHost(), "apt-local-archive-install")), candidateProfiles, Object.freeze([]))];`;
    await writeFile(entryPath, entry.replace(anchor, injected));
    await writeFile(join(staged, "bin", "candidate-command-observer.ts"), await readFile(join(repository, "scripts", "candidate-command-observer.ts")));
    await writeFile(join(staged, "bin", "native-candidate-catalog.ts"), `// Internal immutable source-owned catalog; verified means admission only.\nconst profile = ${JSON.stringify(profile, null, 2)} as const;\nObject.freeze(profile.packages);\nfor (const artifact of Object.values(profile.artifacts)) Object.freeze(artifact);\nObject.freeze(profile.artifacts);\nexport const candidateProfiles = Object.freeze([Object.freeze(profile)]);\n`);
    const manifest = JSON.parse(await readFile(join(staged, "package.json"), "utf8"));
    manifest.name = "fleur-internal-native-candidate";
    manifest.private = true;
    manifest.fleurInternalNativeCandidate = { catalogId: catalog.catalogId, catalogSha256, installationEvidence: "pending", runtimeSupport: "unverified" };
    manifest.files = [...manifest.files, markerName, catalogName];
    await writeFile(join(staged, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(join(staged, markerName), JSON.stringify(metadata, null, 2) + "\n");
    await writeFile(join(staged, catalogName), catalogBytes, { flag: "wx", mode: 0o644 });
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
if ((args.length !== 2 && args.length !== 4) || args[0] !== "--out" || !args[1] || (args.length === 4 && (args[2] !== "--fixture" || !["ubuntu24-amd64", "ubuntu26-amd64"].includes(args[3]!)))) {
  process.stderr.write("Use --out <new-owned-directory> [--fixture <ubuntu24-amd64|ubuntu26-amd64>]; candidate profiles are source-owned.\n");
  process.exitCode = 2;
} else {
  try { await build(resolve(args[1]), args[3] === "ubuntu26-amd64" ? "ubuntu26-amd64" : "ubuntu24-amd64"); }
  catch (error) { process.stderr.write((error instanceof Error ? error.message : "Internal candidate build failed") + "\n"); process.exitCode = 1; }
}
