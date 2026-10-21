import { constants, closeSync, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import { observeGuestSessions } from "./observe-fresh-linux-session.ts";
import { waitForGuestBoot } from "./observe-fresh-linux-boot.ts";
import { observePreparation } from "./observe-fresh-linux-preparation.ts";
import compilerManifest from "./guest-compiler-ubuntu24-amd64.json";
import { observeOwnedGuestCustody } from "./observe-owned-guest-custody.ts";
import { ownedGuestSeed, attestOwnedGuestBoot, copyOwnedGuestBinding } from "./owned-guest-seed.ts";

// Internal verification only. Catalog admission requires separately reviewed source.
const imagePin = { sha256: "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94", size: 621284352 };
const bunPin = { sha256: "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18", entry: "bun-linux-x64/bun", maxBytes: 160 * 1024 * 1024 };
const repository = resolve(import.meta.dir, "..");
const report: Record<string, unknown> = { formatVersion: 1, ok: false, scope: "fresh-full-system-guest", runtimeSupport: "unverified", installationEvidence: "pending", executed: false, humanConsentProof: false, nativeCpuPerformanceProof: false };
let scratch: string | undefined;
let vm: ReturnType<typeof Bun.spawn> | undefined;
let vmOutput: Promise<string[]> | undefined;
let qmpPath: string | undefined;
let stopped = true;
let artifactRecoveryRequired = false;
const sessionAbort = new AbortController();
let sessionOperation: ReturnType<typeof observeGuestSessions> | undefined;
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const tools = ["qemu-img", "qemu-system-x86_64", "cloud-localds", "ssh", "ssh-keygen", "scp", "unzip", "python3", "git", "hdiutil", "/bin/ps"];
function accelerator(): "tcg" | "kvm" {
  const value = process.env.FLEUR_GUEST_ACCELERATOR ?? "tcg";
  if (value !== "tcg" && value !== "kvm") return fail("ARGUMENT_INVALID", "Guest accelerator must be exactly tcg or kvm.");
  if (platform() === "darwin" && value !== "tcg") return fail("HOST_ACCELERATOR_UNSUPPORTED", "Darwin verification hosts support only explicit TCG emulation.");
  return value;
}
function capabilities() {
  const hostPolicy = arch() === "x64" && platform() === "darwin" ? { admitted: true, seedBuilder: "hdiutil", accelerators: ["tcg"] }
    : arch() === "x64" && platform() === "linux" ? { admitted: true, seedBuilder: "cloud-localds", accelerators: ["tcg", "kvm"] }
      : { admitted: false, seedBuilder: null, accelerators: [] };
  return { hostPolicy, system: platform(), architecture: arch(), kernel: release(), tools: Object.fromEntries(tools.map((name) => [name, Bun.which(name) !== null])), kvmUsable: "unproven-until-boot", runnerImage: process.env.ImageVersion ?? null };
}
async function bounded(stream: ReadableStream<Uint8Array>, limit = 2 * 1024 * 1024): Promise<string> {
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) fail("OUTPUT_LIMIT", "Verification command exceeded its output budget."); chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
async function command(args: string[], timeout = 30000, allowed: number[] = [0]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(args, { cwd: scratch ?? repository, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, SSH_AUTH_SOCK: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined }, timeout, killSignal: "SIGKILL" });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
    if (!allowed.includes(exitCode)) fail("COMMAND_FAILED", `${args[0]} failed with ${exitCode}: ${stderr.slice(-2048)}`);
    return { stdout, stderr, exitCode };
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}
async function authenticate(path: string, pin: { sha256: string; size?: number; maxBytes?: number }, destination?: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0 || (pin.size !== undefined && before.size !== pin.size) || before.size > (pin.maxBytes ?? pin.size!)) fail("ARTIFACT_MISMATCH", "Artifact size differs from the authenticated release.");
    const output = destination ? await open(destination, "wx", 0o600) : undefined;
    const hash = new Bun.CryptoHasher("sha256");
    try { for await (const bytes of file.createReadStream({ autoClose: false, end: before.size - 1, signal: AbortSignal.timeout(120000) })) { hash.update(bytes); if (output) await output.writeFile(bytes); } await output?.sync(); }
    finally { await output?.close(); }
    const after = await file.stat();
    const digest = hash.digest("hex");
    if (digest !== pin.sha256 || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("ARTIFACT_MISMATCH", "Artifact bytes differ from the authenticated release.");
    return digest;
  } finally { await file.close(); }
}
/** Internal source-builder selection, never a caller archive or profile override. */
export async function selectVerificationArtifact(directory: string, built: { candidate: { filename: string; sha256: string }; ordinary: { filename: string; sha256: string } }, selection: string, stagingRoot: string) {
  if (selection !== "source-owned" && selection !== "ordinary-source-owned") fail("ARGUMENT_INVALID", "An exact source-owned artifact mode is required.");
  if (built?.candidate?.filename !== "fleur-internal-native-candidate.tgz" || built?.ordinary?.filename !== "fleur-ordinary.tgz"
      || !/^[a-f0-9]{64}$/.test(built.candidate.sha256) || !/^[a-f0-9]{64}$/.test(built.ordinary.sha256)) fail("ARTIFACT_MISMATCH", "Source builder artifact identities are invalid.");
  if (selection === "source-owned") {
    const archive = join(directory, "fleur-internal-native-candidate.tgz");
    await authenticate(archive, { sha256: built.candidate.sha256, maxBytes: 8 * 1024 * 1024 });
    return { kind: "internal-candidate" as const, path: archive, sha256: built.candidate.sha256 };
  }
  if (process.platform !== "darwin" && process.platform !== "linux") fail("INFRASTRUCTURE_UNAVAILABLE", "Descriptor-relative artifact publication is unavailable.");
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const renameSymbol = process.platform === "darwin" ? "renameatx_np" : "renameat2";
  const library = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    [renameSymbol]: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    mkstemp: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const retained: { path: string; handle: Awaited<ReturnType<typeof open>>; dev: number; ino: number }[] = [];
  const identity = (value: ReturnType<typeof fstatSync>) => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.nlink];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const verifyParents = async () => {
    for (const parent of retained) {
      const current = await lstat(parent.path); const bound = await parent.handle.stat();
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== parent.dev || current.ino !== parent.ino
          || bound.dev !== parent.dev || bound.ino !== parent.ino || bound.uid !== process.getuid?.() || (bound.mode & 0o077) !== 0) fail("ARTIFACT_MISMATCH", "Owned artifact directory custody changed.");
    }
  };
  const outputDirectory = join(stagingRoot, "ordinary-execution"); const archive = join(outputDirectory, "fleur-internal-native-candidate.tgz");
  const directoryName = Buffer.from("ordinary-execution\0"); const outputName = Buffer.from("fleur-internal-native-candidate.tgz\0");
  let outputFd = -1; let copyFd = -1; let publishedFd = -1; let namedCopyFd = -1;
  let tempParent: Awaited<ReturnType<typeof open>> | undefined; let copyPath: string | undefined;
  let directoryCreated = false; let copyAllocationAttempted = false; let copyMoved = false;
  const tempRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const verifyTemporaryRoot = async () => {
    if (!tempParent) throw new Error("System temporary parent is not retained");
    const bound = await tempParent.stat(); const visible = await lstat(tempRoot);
    if (!bound.isDirectory() || bound.uid !== 0 || visible.isSymbolicLink() || visible.dev !== bound.dev || visible.ino !== bound.ino
        || ((bound.mode & 0o022) !== 0 && (bound.mode & 0o1000) === 0)) fail("INFRASTRUCTURE_UNAVAILABLE", "System temporary parent custody is invalid.");
    for (let path = dirname(tempRoot);;) {
      const parent = await lstat(path);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) fail("INFRASTRUCTURE_UNAVAILABLE", "System temporary ancestor is not protected.");
      const next = dirname(path); if (next === path) break; path = next;
    }
    if (bound.dev !== retained[1]!.dev) fail("INFRASTRUCTURE_UNAVAILABLE", "Atomic artifact publication requires one filesystem.");
  };
  try {
    for (const path of [directory, stagingRoot]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat(); retained.push({ path, handle, dev: info.dev, ino: info.ino });
    }
    await verifyParents();
    const source = join(directory, "fleur-ordinary.tgz");
    await authenticate(source, { sha256: built.ordinary.sha256, maxBytes: 8 * 1024 * 1024 });
    tempParent = await open(tempRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await verifyTemporaryRoot();
    const template = Buffer.from(join(tempRoot, "fleur-ordinary-copy-XXXXXX") + "\0");
    copyAllocationAttempted = true; copyFd = library.symbols.mkstemp(ptr(template));
    if (copyFd < 0) throw new Error("Exclusive private copy creation failed");
    copyPath = template.toString().split("\0")[0]!;
    const privateFile = fstatSync(copyFd);
    if (!privateFile.isFile() || privateFile.uid !== process.getuid?.() || privateFile.nlink !== 1 || privateFile.size !== 0 || (privateFile.mode & 0o077) !== 0) fail("ARTIFACT_MISMATCH", "Private copy file custody is invalid.");
    const copyName = Buffer.from(copyPath.slice(tempRoot.length + 1) + "\0");
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await input.stat(); const hash = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let count = 0;
      if (!before.isFile() || before.size <= 0 || before.size > 8 * 1024 * 1024) fail("ARTIFACT_MISMATCH", "Ordinary source size changed.");
      while (count < before.size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - count), count);
        if (!bytesRead) fail("ARTIFACT_MISMATCH", "Ordinary source ended early.");
        hash.update(buffer.subarray(0, bytesRead)); let written = 0;
        while (written < bytesRead) { const size = writeSync(copyFd, buffer, written, bytesRead - written); if (!size) throw new Error("Private copy write made no progress"); written += size; }
        count += bytesRead;
      }
      const after = await input.stat();
      if (!same(identity(before), identity(after)) || hash.digest("hex") !== built.ordinary.sha256) fail("ARTIFACT_MISMATCH", "Ordinary source bytes changed.");
      fsyncSync(copyFd);
    } finally { await input.close(); }
    await verifyParents();
    if (library.symbols.mkdirat(retained[1]!.handle.fd, ptr(directoryName), 0o700) !== 0) throw new Error("Exclusive ordinary staging creation failed");
    directoryCreated = true;
    outputFd = library.symbols.openat(retained[1]!.handle.fd, ptr(directoryName), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (outputFd < 0) throw new Error("Owned ordinary staging could not be retained");
    const ownedDirectory = fstatSync(outputFd); const visibleDirectory = await lstat(outputDirectory);
    if (!ownedDirectory.isDirectory() || ownedDirectory.uid !== process.getuid?.() || (ownedDirectory.mode & 0o077) !== 0 || visibleDirectory.dev !== ownedDirectory.dev || visibleDirectory.ino !== ownedDirectory.ino || visibleDirectory.isSymbolicLink()) fail("ARTIFACT_MISMATCH", "Ordinary staging identity changed.");
    await verifyTemporaryRoot();
    namedCopyFd = library.symbols.openat(tempParent.fd, ptr(copyName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (namedCopyFd < 0 || !same(identity(fstatSync(namedCopyFd)), identity(fstatSync(copyFd)))) fail("ARTIFACT_MISMATCH", "Named temporary copy no longer matches its held descriptor.");
    // macOS SDK sys/stdio.h: RENAME_EXCL=4; Linux stdio.h: RENAME_NOREPLACE=1.
    const exclusive = process.platform === "darwin" ? 4 : 1;
    if (library.symbols[renameSymbol]!(tempParent.fd, ptr(copyName), outputFd, ptr(outputName), exclusive) !== 0) throw new Error("Exclusive descriptor-relative publication failed");
    copyMoved = true;
    publishedFd = library.symbols.openat(outputFd, ptr(outputName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (publishedFd < 0) throw new Error("Published artifact could not be retained");
    const copied = fstatSync(copyFd); const published = fstatSync(publishedFd);
    if (!published.isFile() || published.dev !== copied.dev || published.ino !== copied.ino || published.nlink !== 1) fail("ARTIFACT_MISMATCH", "Published copy inode changed.");
    await verifyParents();
    const visible = await lstat(archive); const directoryAfter = await lstat(outputDirectory);
    if (directoryAfter.isSymbolicLink() || directoryAfter.dev !== ownedDirectory.dev || directoryAfter.ino !== ownedDirectory.ino || !visible.isFile() || visible.isSymbolicLink() || visible.dev !== published.dev || visible.ino !== published.ino) fail("ARTIFACT_MISMATCH", "Published ordinary path custody changed.");
    const beforeRead = fstatSync(publishedFd); const digest = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let offset = 0;
    if (beforeRead.nlink !== 1 || beforeRead.size <= 0 || beforeRead.size > 8 * 1024 * 1024) fail("ARTIFACT_MISMATCH", "Published ordinary size or links changed.");
    while (true) { const bytes = readSync(publishedFd, buffer, 0, buffer.length, offset); if (!bytes) break; offset += bytes; if (offset > beforeRead.size) fail("ARTIFACT_MISMATCH", "Published copy grew during readback."); digest.update(buffer.subarray(0, bytes)); }
    if (offset !== beforeRead.size || digest.digest("hex") !== built.ordinary.sha256 || !same(identity(beforeRead), identity(fstatSync(publishedFd)))) fail("ARTIFACT_MISMATCH", "Published ordinary bytes changed.");
    return { kind: "ordinary" as const, path: archive, sha256: built.ordinary.sha256 };
  } catch (error) {
    // Do not delete named copies, published entries or replaced directories on uncertainty.
    throw Object.assign(error instanceof Error ? error : new Error("Ordinary artifact staging failed"), {
      artifactCleanupConfirmed: !directoryCreated && !copyAllocationAttempted,
      artifactRetainedCopyCandidate: copyMoved ? undefined : copyPath,
      artifactStagingRetained: directoryCreated,
    });
  } finally {
    for (const fd of [publishedFd, namedCopyFd, copyFd, outputFd]) if (fd >= 0) closeSync(fd);
    await tempParent?.close(); await Promise.all(retained.map((parent) => parent.handle.close())); library.close();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") return fail("TRANSPORT_FAILED", "Loopback port allocation failed.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function poweroff(): Promise<void> {
  if (!qmpPath) return;
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(qmpPath!); let buffer = ""; let stage = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("QMP shutdown timed out")); }, 3000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(); };
    socket.on("error", finish);
    socket.on("data", (data) => {
      buffer += data.toString(); if (buffer.length > 65536) return finish(new Error("QMP output exceeded limit"));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value: Record<string, unknown>; try { value = JSON.parse(line); } catch { return finish(new Error("Malformed QMP response")); }
        if (stage === 0 && value.QMP) { stage = 1; socket.write('{"execute":"qmp_capabilities","id":"cap"}\n'); }
        else if (stage === 1 && value.id === "cap" && value.return) { stage = 2; socket.write('{"execute":"system_powerdown","id":"off"}\n'); }
        else if (stage === 2 && value.id === "off") return finish(value.error ? new Error("QMP powerdown rejected") : undefined);
      }
    });
  });
}
/** Fixed two-file verification input only; callers cannot choose pins or origin policy. */
export async function stageRecordedHelperInputs(input: string, output: string) {
  const source = `import json, pathlib, sys, time
sys.path.insert(0, sys.argv[1])
from helper_artifacts import recorded_helper_contract, ArtifactPin, PairSpec, stage_pair
end=time.monotonic()+9
metadata=recorded_helper_contract(end)
pins={item['name']:ArtifactPin(item['bytes'],item['sha256']) for item in metadata['helpers']}
result=stage_pair(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),PairSpec(pins['filter.so'],pins['abuse']),end)
print(json.dumps({'manifestSha256':'26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b','files':{name:{'size':item['bytes'],'sha256':item['sha256']} for name,item in result['files'].items()}}))`;
  try {
    await mkdir(output, { mode: 0o700 });
    const staged = await command(["python3", "-I", "-c", source, join(repository, "experiments/compatibility/runtime-probe"), input, output], 10000);
    const receipt = JSON.parse(staged.stdout);
    return receipt as { manifestSha256: string; files: Record<string, { size: number; sha256: string }> };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("Recorded helper staging failed"), { artifactCleanupConfirmed: false, artifactStagingRetained: true });
  }
}
async function execute(imagePath: string, bunArchivePath: string, compilerDirectory?: string, selection: "source-owned" | "ordinary-source-owned" = "source-owned", recordedDirectory?: string): Promise<void> {
  // Authenticate before tools interpret any supplied image or archive.
  await authenticate(imagePath, imagePin);
  await authenticate(bunArchivePath, bunPin);
  const available = capabilities(); report.capabilities = available;
  const requiredTools = tools.filter((name) => name !== (platform() === "darwin" ? "cloud-localds" : "hdiutil"));
  if (!available.hostPolicy.admitted || requiredTools.some((name) => !available.tools[name])) fail("INFRASTRUCTURE_UNAVAILABLE", "An admitted Linux x64 or Darwin x64 TCG verification host with its required existing tools is required.");
  scratch = await mkdtemp(join(tmpdir(), "fleur-fresh-linux-"));
  if (/[,\r\n]/.test(scratch) || Buffer.byteLength(join(scratch, "qmp.sock")) > 100) fail("INFRASTRUCTURE_UNAVAILABLE", "Private temporary path cannot be represented safely in QEMU options or Unix socket addresses.");
  const recordedBundle = recordedDirectory ? join(scratch, "recorded-helpers") : undefined;
  if (recordedBundle) {
    report.helperMode = "recorded-prebuilt";
    report.recordedHelperInputs = await stageRecordedHelperInputs(recordedDirectory!, recordedBundle);
  }
  const compilerManifestSha256 = "11127a1f28b3bac544f79d0f0bc4f91a68afec74568c342bc4bb7c773dcf00d7";
  const compilerBundle = compilerDirectory ? join(scratch, "compiler-debs") : undefined;
  if (compilerBundle) {
    if (Bun.CryptoHasher.hash("sha256", await readFile(join(repository, "scripts/guest-compiler-ubuntu24-amd64.json")), "hex") !== compilerManifestSha256) fail("ARTIFACT_MISMATCH", "Source-owned compiler manifest differs.");
    await mkdir(compilerBundle, { mode: 0o700 });
    for (const artifact of compilerManifest.artifacts) await authenticate(join(compilerDirectory!, artifact.file), { sha256: artifact.sha256, size: artifact.bytes }, join(compilerBundle, artifact.file));
    report.compilerBundle = { scope: compilerManifest.scope, manifestSha256: compilerManifestSha256, packages: compilerManifest.artifacts.length, bytes: compilerManifest.totalBytes, authenticated: true, installedOnHost: false };
  }
  // Retained private handles copy the exact authenticated bytes; original paths never reach QEMU.
  const base = join(scratch, "base.qcow2"); const runtime = join(scratch, "bun.zip");
  await authenticate(imagePath, imagePin, base); await authenticate(bunArchivePath, bunPin, runtime);
  const info = JSON.parse((await command(["qemu-img", "info", "--output=json", "-f", "qcow2", base])).stdout);
  if (info.format !== "qcow2" || info["virtual-size"] !== 3758096384 || info["backing-filename"] || info["full-backing-filename"] || info["data-file"] || info.encrypted === true || info.snapshots?.length) fail("ARTIFACT_MISMATCH", "Unexpected cloud image backing chain, external data, encryption or snapshots.");
  report.image = { ...imagePin, format: info.format, virtualSize: info["virtual-size"], validation: JSON.parse((await command(["qemu-img", "check", "--output=json", "-f", "qcow2", base], 60000)).stdout) };
  const overlay = join(scratch, "overlay.qcow2");
  await command(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", base, overlay, "12G"]);
  const overlayInfo = JSON.parse((await command(["qemu-img", "info", "--output=json", "-f", "qcow2", overlay])).stdout);
  if (overlayInfo["full-backing-filename"] !== base || overlayInfo["backing-filename-format"] !== "qcow2") fail("ARTIFACT_MISMATCH", "Overlay backing identity differs.");
  const candidate = join(scratch, "candidate");
  const built = JSON.parse((await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", candidate], 120000)).stdout);
  if (built.internalArtifact !== true || built.installationEvidence !== "pending" || built.runtimeSupport !== "unverified") fail("ARTIFACT_MISMATCH", "Candidate does not retain pending/unverified provenance.");
  report.candidate = built;
  report.verificationSources = await Promise.all(["scripts/verify-fresh-linux.ts", "scripts/candidate-command-observer.ts", "scripts/observe-fresh-linux-boot.ts", "scripts/observe-fresh-linux-preparation.ts", "scripts/retained-ssh.ts", "scripts/retained-ssh.py", "scripts/observe-fresh-linux-session.ts", "scripts/archive-fresh-linux-probe.ts", "scripts/fresh-linux-guest.py", "scripts/prepare-fresh-linux-guest.py", "scripts/prepare-nocloud-seed.py", "scripts/prepare-guest-compiler.py", "scripts/guest-compiler-ubuntu24-amd64.json", "scripts/owned-guest-seed.ts", "scripts/observe-owned-guest-custody.ts", "experiments/compatibility/runtime-probe/owned_guest.py", "experiments/compatibility/runtime-probe/host_control.py", "experiments/compatibility/runtime-probe/privileged_control.py", "experiments/compatibility/runtime-probe/helper_artifacts.py", "experiments/compatibility/runtime-probe/recorded-helper-origin.json"].map(async (path) => ({ path, sha256: Bun.CryptoHasher.hash("sha256", await readFile(join(repository, path)), "hex") })));
  const selectedArtifact = await selectVerificationArtifact(candidate, built, selection, scratch);
  const archive = selectedArtifact.path;
  report.executionArtifact = { kind: selectedArtifact.kind, sha256: selectedArtifact.sha256,
    sourceFilename: selectedArtifact.kind === "ordinary" ? "fleur-ordinary.tgz" : "fleur-internal-native-candidate.tgz",
    transportFilename: "fleur-internal-native-candidate.tgz" };
  const clientKey = join(scratch, "client"); const hostKey = join(scratch, "host");
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  const nonce = crypto.randomUUID();
  const seedInputs = join(scratch, "seed-inputs"); await mkdir(seedInputs, { mode: 0o700 });
  const metadata = join(seedInputs, "meta-data"); const userdata = join(seedInputs, "user-data"); const seed = join(scratch, "seed.img");
  const metadataText = JSON.stringify({ "instance-id": nonce, "local-hostname": "fleur-proof" });
  await writeFile(metadata, metadataText, { flag: "wx", mode: 0o600 });
  const userdataText = "#cloud-config\n" + JSON.stringify({
    users: [{ name: "fleur", groups: ["sudo"], sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true, ssh_authorized_keys: [(await readFile(clientKey + ".pub", "utf8")).trim()] }],
    ssh_pwauth: false, disable_root: true,
    ssh_keys: { ed25519_private: await readFile(hostKey, "utf8"), ed25519_public: (await readFile(hostKey + ".pub", "utf8")).trim() },
    ...await ownedGuestSeed(nonce),
    package_update: false, package_upgrade: false,
  });
  await writeFile(userdata, userdataText, { flag: "wx", mode: 0o600 });
  if (platform() === "darwin") {
    const result = JSON.parse((await command(["python3", "-I", join(repository, "scripts/prepare-nocloud-seed.py"), "--source", seedInputs, "--output", seed])).stdout);
    if (result.formatVersion !== 1 || result.scope !== "owned-nocloud-seed" || result.ok !== true || result.volumeLabel !== "cidata" || result.files?.["meta-data"] !== Bun.CryptoHasher.hash("sha256", metadataText, "hex") || result.files?.["user-data"] !== Bun.CryptoHasher.hash("sha256", userdataText, "hex") || typeof result.imageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.imageSha256)) fail("SEED_REPORT_INVALID", "The owned seed did not authenticate the exact NoCloud inputs.");
    await authenticate(seed, { sha256: result.imageSha256, maxBytes: 8 * 1024 * 1024 });
    report.seed = { ...result, builder: "hdiutil" };
  } else await command(["cloud-localds", seed, userdata, metadata]);
  const port = await freePort(); const knownHosts = join(scratch, "known_hosts");
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${(await readFile(hostKey + ".pub", "utf8")).trim()}\n`, { flag: "wx", mode: 0o600 });
  qmpPath = join(scratch, "qmp.sock");
  const selectedAccelerator = accelerator();
  report.accelerator = selectedAccelerator; report.nativeCpuPerformanceProof = false;
  vm = Bun.spawn(["qemu-system-x86_64", "-name", `fleur-${nonce}`, "-machine", "q35", "-accel", selectedAccelerator, "-cpu", selectedAccelerator === "kvm" ? "host" : "max", "-smp", "2", "-m", "3072", "-display", "none", "-monitor", "none", "-serial", "stdio", "-no-reboot", "-qmp", `unix:${qmpPath},server=on,wait=off`, "-drive", `file=${overlay},format=qcow2,if=virtio`, "-drive", `file=${seed},format=raw,if=virtio,readonly=on`, "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${port}-:22`, "-device", "virtio-net-pci,netdev=net0"], { cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  stopped = false; report.executed = true;
  vmOutput = Promise.all([bounded(vm.stdout as ReadableStream<Uint8Array>, 4 * 1024 * 1024), bounded(vm.stderr as ReadableStream<Uint8Array>)]);
  void vmOutput.catch(() => { if (vm?.exitCode === null) vm.kill("SIGKILL"); });
  const sshOptions = ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", clientKey];
  const ssh = (...remote: string[]) => command(["ssh", ...sshOptions, "-p", String(port), "fleur@127.0.0.1", ...remote], 10000, [0, 255]);
  const bootDeadline = performance.now() + 180000;
  const bootCancellation = new AbortController();
  if (vm.exitCode !== null) bootCancellation.abort();
  void vm.exited.then(() => bootCancellation.abort(), () => bootCancellation.abort());
  const readiness = await waitForGuestBoot({ port, identity: clientKey, knownHosts, nonce }, { deadline: bootDeadline, signal: bootCancellation.signal });
  report.lastBootObservation = readiness.lastBootObservation;
  if (vm.exitCode !== null) fail("BOOT_FAILED", "Owned QEMU exited before guest readiness.");
  if (!readiness.ok) fail(readiness.error?.code ?? "BOOT_FAILED", readiness.error?.message ?? "Guest boot observation failed.");
  report.boot = { hostKeyPinnedBeforeBoot: true, cloudInitComplete: true, scope: "full-system-qemu", accelerator: selectedAccelerator };
  const custody = await attestOwnedGuestBoot({ nonce, deadline: bootDeadline,
    query: async (_remote, timeoutMs) => {
      const observation = await observeOwnedGuestCustody({ port, identity: clientKey, knownHosts, nonce }, timeoutMs, bootCancellation.signal);
      report.ownedGuestCustodyTransport = { ...observation, stdout: undefined };
      return observation;
    } });
  report.ownedGuestCustody = custody;
  const ownedGuestBinding = copyOwnedGuestBinding({ nonce: custody.nonce, bootId: custody.bootId, uid: custody.uid, manifestSha256: custody.manifestSha256 }, nonce);
  await ssh("mkdir -m 700 lab");
  const restrictionArchive = join(scratch, "runtime-probe.tar");
  const sourceCommit = (await command(["git", "-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("ARTIFACT_MISMATCH", "Runtime probe source revision is malformed.");
  const restriction = JSON.parse((await command([process.execPath, join(repository, "scripts/archive-fresh-linux-probe.ts"), "--repository", repository, "--commit", sourceCommit, "--out", restrictionArchive])).stdout);
  const restrictionSha256 = Bun.CryptoHasher.hash("sha256", await readFile(restrictionArchive), "hex");
  if (restriction.formatVersion !== 1 || restriction.scope !== "fresh-linux-restriction-archive" || restriction.ok !== true || restriction.commit !== sourceCommit || restriction.sha256 !== restrictionSha256) fail("ARTIFACT_MISMATCH", "Restriction archive did not establish its exact tracked source identity.");
  report.restrictionSource = restriction;
  const guestFiles = [archive, runtime, restrictionArchive, join(repository, "scripts/fresh-linux-guest.py"), join(repository, "scripts/prepare-fresh-linux-guest.py")];
  if (compilerBundle) guestFiles.push(join(repository, "scripts/prepare-guest-compiler.py"), join(repository, "scripts/guest-compiler-ubuntu24-amd64.json"));
  await command(["scp", ...sshOptions, "-P", String(port), ...guestFiles, "fleur@127.0.0.1:lab/"], 120000);
  if (compilerBundle) await command(["scp", ...sshOptions, "-r", "-P", String(port), compilerBundle, "fleur@127.0.0.1:lab/"], 120000);
  if (recordedBundle) {
    // Only the two fixed authenticated inputs are copied; no compiler provisioning.
    await ssh("mkdir -m 700 lab/recorded-helpers");
    await command(["scp", ...sshOptions, "-P", String(port), join(recordedBundle, "filter.so"), join(recordedBundle, "abuse"), "fleur@127.0.0.1:lab/recorded-helpers/"], 120000);
  }
  const preparationObservation = await observePreparation({ port, identity: clientKey, knownHosts, nonce });
  report.preparationObservation = preparationObservation;
  if (!preparationObservation.ok) fail(preparationObservation.error?.code ?? "PREPARATION_INCOMPLETE", preparationObservation.error?.message ?? "Guest artifact preparation did not complete.");
  const preparation = preparationObservation.bun!;
  if (preparation.formatVersion !== 1 || preparation.scope !== "guest-bun-preparation" || preparation.ok !== true || preparation.archiveSha256 !== bunPin.sha256 || typeof preparation.executableBytes !== "number" || !Number.isSafeInteger(preparation.executableBytes) || preparation.executableBytes <= 0 || preparation.executableBytes > 256 * 1024 * 1024 || typeof preparation.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(preparation.executableSha256)) fail("GUEST_REPORT_INVALID", "Guest Bun preparation did not establish its authenticated output identity.");
  report.guestPreparation = preparation;
  if (compilerBundle) {
    // A distinct verification prerequisite phase precedes all Docker baseline
    // snapshots and the original session deadline. It has no network fallback.
    const prepared = await command(["ssh", ...sshOptions, "-p", String(port), "fleur@127.0.0.1", `cd lab && sudo -n /usr/bin/python3 -I prepare-guest-compiler.py ${nonce}`], 250000, [0, 4]);
    const compiler = JSON.parse(prepared.stdout); report.compilerPreparation = compiler;
    if (prepared.exitCode !== 0 || compiler.formatVersion !== 1 || compiler.scope !== "verification-only-compiler-prerequisite" || compiler.ok !== true || compiler.fleurSetupAction !== false || compiler.runtimeSupport !== "unverified" || compiler.installationEvidence !== "pending" || compiler.manifestSha256 !== compilerManifestSha256 || compiler.packageCount !== 38 || compiler.totalBytes !== compilerManifest.totalBytes || compiler.order !== "before-docker-baseline-and-session-deadline" || compiler.ownedPackageStageRemoved !== true || compiler.compiler?.sha256 !== compilerManifest.compiler.sha256 || compiler.compiler?.version !== compilerManifest.compiler.version || compiler.compiler?.target !== compilerManifest.compiler.target || JSON.stringify(compiler.packages) !== JSON.stringify(compilerManifest.artifacts) || !Array.isArray(compiler.helperBuild) || compiler.helperBuild.length !== 2 || !["filter.so", "abuse"].every((name) => compiler.helperBuild.some((item: Record<string, unknown>) => item.name === name && item.elfMachine === 62 && item.executed === false && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256)))) fail("GUEST_REPORT_INVALID", "Compiler verification prerequisite did not establish its exact authenticated closure, native identity, helper compilation and cleanup.");
  }
  const cancelSession = () => sessionAbort.abort();
  process.once("SIGINT", cancelSession); process.once("SIGTERM", cancelSession);
  let sessions;
  try {
    sessionOperation = observeGuestSessions({ port, identity: clientKey, knownHosts, nonce, ownedGuestBinding, ...(recordedBundle ? { recordedHelpers: true as const } : {}) }, sessionAbort.signal);
    sessions = await sessionOperation;
  } finally { process.removeListener("SIGINT", cancelSession); process.removeListener("SIGTERM", cancelSession); }
  report.sessions = sessions;
  // Parse the scoped transport observation as data, retaining the original proof checks below.
  const guest = JSON.parse(JSON.stringify(sessions.guest ?? {})); report.guest = guest;
  if (sessions.error) fail(sessions.error.code, sessions.error.message);
  if (selection === "ordinary-source-owned" && (guest.executionArtifact?.kind !== "ordinary" || guest.executionArtifact?.packageName !== "fleur")) fail("GUEST_REPORT_INVALID", "Ordinary artifact execution did not retain its actual package identity.");
  if (guest.formatVersion !== 1 || guest.runtimeSupport !== "unverified" || guest.humanConsentProof !== false || guest.phase !== undefined) fail("GUEST_REPORT_INVALID", "Guest proof metadata differs from its declared terminal scope.");
  if (guest.ok !== true) fail(guest.error?.code ?? "NATIVE_SETUP_INCOMPLETE", guest.error?.message ?? "Guest setup proof is incomplete.");
  if (guest.installationEvidence !== "verified-full-system-guest" || guest.runs?.length !== 2 || guest.sentinelCleanup !== true || guest.restrictionProbe?.exitCode !== 0 || guest.restrictionProbe?.result?.bounded_probe_passed !== true || guest.restrictionProbe?.result?.cleanup_complete !== true) fail("GUEST_REPORT_INVALID", "Successful guest report lacks completed repeat, restriction or cleanup evidence.");
  // Admission is always an independently reviewed later source change.
  report.installationEvidence = "verified-full-system-guest";
  report.ok = true;
}
if (import.meta.main) {
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--observe") { report.capabilities = capabilities(); fail("INFRASTRUCTURE_UNAVAILABLE", "Observation does not establish fresh guest execution or native readiness."); }
  if (process.env.FLEUR_OWNED_DISPOSABLE_HOST !== "yes") fail("OWNED_HOST_REQUIRED", "Explicit owned disposable host opt-in is required.");
  if ((args.length !== 7 && args.length !== 9) || (args.length === 9 && args[7] !== "--compiler-debs" && args[7] !== "--recorded-helper-artifacts") || args[0] !== "--run" || args[1] !== "--image" || args[3] !== "--candidate" || args[5] !== "--bun-archive") fail("ARGUMENT_INVALID", "Use --run --image <exact-image> --candidate <source-owned|ordinary-source-owned> --bun-archive <exact-Bun-zip> [--compiler-debs <exact-payload-directory> | --recorded-helper-artifacts <fixed-pair-directory>].");
  accelerator();
  // A candidate archive supplied by a caller is never executed. Build from this source.
  if (args[4] !== "source-owned" && args[4] !== "ordinary-source-owned") {
    await authenticate(args[2]!, imagePin);
    fail("ARGUMENT_INVALID", "Candidate must be source-owned or ordinary-source-owned; arbitrary archives or profile overrides are refused.");
  }
  await execute(resolve(args[2]!), resolve(args[6]!), args[7] === "--compiler-debs" ? resolve(args[8]!) : undefined, args[4] === "ordinary-source-owned" ? "ordinary-source-owned" : "source-owned", args[7] === "--recorded-helper-artifacts" ? resolve(args[8]!) : undefined);
} catch (error) {
  const recovery = error as { artifactCleanupConfirmed?: boolean; artifactRetainedCopyCandidate?: string; artifactStagingRetained?: boolean };
  if (recovery.artifactCleanupConfirmed === false) {
    artifactRecoveryRequired = true;
    report.artifactRecovery = { cleanupConfirmed: false, stagingRetained: recovery.artifactStagingRetained === true,
      retainedCopyCandidate: recovery.artifactRetainedCopyCandidate ?? null };
  }
  report.error = { code: (error as { code?: string }).code ?? "VERIFICATION_FAILED", message: error instanceof Error ? error.message : "Verification failed" };
  process.exitCode = 4;
} finally {
  sessionAbort.abort();
  await sessionOperation;
  if (vm) {
    try {
      if (vm.exitCode === null) { try { await poweroff(); } catch { /* Owned child is still reaped below. */ } await Promise.race([vm.exited, new Promise((resolve) => setTimeout(resolve, 10000))]); }
      if (vm.exitCode === null) vm.kill("SIGTERM");
      await Promise.race([vm.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (vm.exitCode === null) vm.kill("SIGKILL");
      await vm.exited; stopped = true;
      report.serial = await vmOutput;
    } catch { report.ok = false; report.cleanupError = "Owned VM termination or serial evidence could not be confirmed."; process.exitCode = 5; }
  }
  report.cleanup = { ownedVmReaped: stopped, credentialsRemoved: false };
  if (scratch && stopped && !artifactRecoveryRequired) {
    try { await rm(scratch, { recursive: true, force: true });
      if (report.helperMode === "recorded-prebuilt") {
        const absent = async (path: string) => { try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } };
        const scratchRemoved = await absent(scratch); const overlayRemoved = await absent(join(scratch, "overlay.qcow2"));
        report.artifactDisposal = { scope: "owned-full-system-guest-filesystem", vmReaped: stopped, scratchRemoved, overlayRemoved, complete: stopped && scratchRemoved && overlayRemoved };
        if (!scratchRemoved || !overlayRemoved) { report.ok = false; report.cleanupError = "Recorded helper VM filesystem disposal is unconfirmed."; process.exitCode = 5; }
      }
      if (report.helperMode !== "recorded-prebuilt" || (report.artifactDisposal as { complete?: unknown } | undefined)?.complete === true) report.cleanup = { ownedVmReaped: true, credentialsRemoved: true }; }
    catch { report.ok = false; report.cleanupError = "Owned guest scratch cleanup failed."; process.exitCode = 5; }
  }
  if (report.helperMode === "recorded-prebuilt" && (report.artifactDisposal as { complete?: unknown } | undefined)?.complete !== true) {
    report.ok = false; report.artifactDisposal ??= { scope: "owned-full-system-guest-filesystem", complete: false };
    report.error ??= { code: "ARTIFACT_DISPOSAL_UNCONFIRMED", message: "Recorded helper acceptance requires actual owned VM and filesystem disposal." };
    process.exitCode = process.exitCode || 5;
  }
  process.stdout.write(JSON.stringify(report) + "\n");
}
}
