import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection, createServer } from "node:net";

// Internal verification only. The source-owned ordinary production catalog stays empty.
const imagePin = { sha256: "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94", size: 621284352 };
const bunPin = { sha256: "3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18", entry: "bun-linux-x64/bun", maxBytes: 160 * 1024 * 1024 };
const repository = resolve(import.meta.dir, "..");
const report: Record<string, unknown> = { formatVersion: 1, ok: false, scope: "fresh-full-system-guest", runtimeSupport: "unverified", installationEvidence: "pending", executed: false, humanConsentProof: false };
let scratch: string | undefined;
let vm: ReturnType<typeof Bun.spawn> | undefined;
let vmOutput: Promise<string[]> | undefined;
let qmpPath: string | undefined;
let stopped = true;
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const tools = ["qemu-img", "qemu-system-x86_64", "cloud-localds", "ssh", "ssh-keygen", "scp", "unzip", "python3", "git"];
function capabilities() {
  return { system: platform(), architecture: arch(), kernel: release(), tools: Object.fromEntries(tools.map((name) => [name, Bun.which(name) !== null])), kvmUsable: "unproven-until-boot", runnerImage: process.env.ImageVersion ?? null };
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
async function execute(imagePath: string, bunArchivePath: string): Promise<void> {
  // Authenticate before tools interpret any supplied image or archive.
  await authenticate(imagePath, imagePin);
  await authenticate(bunArchivePath, bunPin);
  const available = capabilities(); report.capabilities = available;
  if (platform() !== "linux" || arch() !== "x64" || Object.values(available.tools).some((value) => !value)) fail("INFRASTRUCTURE_UNAVAILABLE", "Same-architecture Linux x64 with QEMU, qemu-img, cloud-localds, SSH, unzip and Python is required.");
  scratch = await mkdtemp(join(tmpdir(), "fleur-fresh-linux-"));
  if (/[,\r\n]/.test(scratch) || Buffer.byteLength(join(scratch, "qmp.sock")) > 100) fail("INFRASTRUCTURE_UNAVAILABLE", "Private temporary path cannot be represented safely in QEMU options or Unix socket addresses.");
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
  report.verificationSources = await Promise.all(["scripts/verify-fresh-linux.ts", "scripts/fresh-linux-guest.py"].map(async (path) => ({ path, sha256: Bun.CryptoHasher.hash("sha256", await readFile(join(repository, path)), "hex") })));
  const archive = join(candidate, "fleur-internal-native-candidate.tgz");
  await authenticate(archive, { sha256: built.candidate.sha256, maxBytes: 8 * 1024 * 1024 });
  const clientKey = join(scratch, "client"); const hostKey = join(scratch, "host");
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", clientKey]);
  await command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  const nonce = crypto.randomUUID();
  const metadata = join(scratch, "meta-data"); const userdata = join(scratch, "user-data"); const seed = join(scratch, "seed.img");
  await writeFile(metadata, JSON.stringify({ "instance-id": nonce, "local-hostname": "fleur-proof" }), { flag: "wx", mode: 0o600 });
  await writeFile(userdata, "#cloud-config\n" + JSON.stringify({
    users: [{ name: "fleur", groups: ["sudo"], sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true, ssh_authorized_keys: [(await readFile(clientKey + ".pub", "utf8")).trim()] }],
    ssh_pwauth: false, disable_root: true,
    ssh_keys: { ed25519_private: await readFile(hostKey, "utf8"), ed25519_public: (await readFile(hostKey + ".pub", "utf8")).trim() },
    write_files: [{ path: "/etc/fleur-owned-guest", permissions: "0444", content: nonce }],
    package_update: false, package_upgrade: false,
  }), { flag: "wx", mode: 0o600 });
  await command(["cloud-localds", seed, userdata, metadata]);
  const port = await freePort(); const knownHosts = join(scratch, "known_hosts");
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${(await readFile(hostKey + ".pub", "utf8")).trim()}\n`, { flag: "wx", mode: 0o600 });
  qmpPath = join(scratch, "qmp.sock");
  const accelerator = process.env.FLEUR_GUEST_ACCELERATOR === "kvm" ? "kvm" : process.env.FLEUR_GUEST_ACCELERATOR === undefined || process.env.FLEUR_GUEST_ACCELERATOR === "tcg" ? "tcg" : fail("ARGUMENT_INVALID", "Guest accelerator must be exactly kvm or tcg.");
  report.accelerator = accelerator; report.nativeCpuPerformanceProof = false;
  vm = Bun.spawn(["qemu-system-x86_64", "-name", `fleur-${nonce}`, "-machine", "q35", "-accel", accelerator, "-cpu", accelerator === "kvm" ? "host" : "max", "-smp", "2", "-m", "3072", "-display", "none", "-monitor", "none", "-serial", "stdio", "-no-reboot", "-qmp", `unix:${qmpPath},server=on,wait=off`, "-drive", `file=${overlay},format=qcow2,if=virtio`, "-drive", `file=${seed},format=raw,if=virtio,readonly=on`, "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${port}-:22`, "-device", "virtio-net-pci,netdev=net0"], { cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  stopped = false; report.executed = true;
  vmOutput = Promise.all([bounded(vm.stdout as ReadableStream<Uint8Array>, 4 * 1024 * 1024), bounded(vm.stderr as ReadableStream<Uint8Array>)]);
  void vmOutput.catch(() => { if (vm?.exitCode === null) vm.kill("SIGKILL"); });
  const sshOptions = ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", clientKey];
  const ssh = (...remote: string[]) => command(["ssh", ...sshOptions, "-p", String(port), "fleur@127.0.0.1", ...remote], 10000, [0, 255]);
  const bootDeadline = performance.now() + 180000;
  while (true) {
    if (vm.exitCode !== null) fail("BOOT_FAILED", "Owned QEMU exited before guest readiness.");
    if ((await ssh("cloud-init status --wait >/dev/null && test \"$(cat /etc/fleur-owned-guest)\" = " + nonce)).exitCode === 0) break;
    if (performance.now() >= bootDeadline) fail("BOOT_TIMEOUT", "Guest did not become ready within three minutes.");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  report.boot = { hostKeyPinnedBeforeBoot: true, cloudInitComplete: true, scope: "full-system-qemu", accelerator };
  await ssh("mkdir -m 700 lab");
  const restrictionArchive = join(scratch, "runtime-probe.tar");
  const sourceCommit = (await command(["git", "-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail("ARTIFACT_MISMATCH", "Runtime probe source revision is malformed.");
  await command(["git", "-C", repository, "archive", "--format=tar", `--output=${restrictionArchive}`, sourceCommit, "experiments/compatibility/runtime-probe"]);
  report.restrictionSource = { commit: sourceCommit, sha256: Bun.CryptoHasher.hash("sha256", await readFile(restrictionArchive), "hex") };
  const guestFiles = [archive, runtime, restrictionArchive, join(repository, "scripts/fresh-linux-guest.py")];
  await command(["scp", ...sshOptions, "-P", String(port), ...guestFiles, "fleur@127.0.0.1:lab/"], 120000);
  const prepare = await ssh("cd lab && unzip -p bun.zip bun-linux-x64/bun > bun && chmod 700 bun && tar -xzf fleur-internal-native-candidate.tgz && tar -xf runtime-probe.tar");
  if (prepare.exitCode !== 0) fail("TRANSPORT_FAILED", "Guest artifact preparation failed.");
  const observed = await command(["ssh", ...sshOptions, "-p", String(port), "fleur@127.0.0.1", `python3 lab/fresh-linux-guest.py ${nonce}`], 900000, [0, 4]);
  const guest = JSON.parse(observed.stdout); report.guest = guest;
  if (guest.formatVersion !== 1 || guest.runtimeSupport !== "unverified" || guest.humanConsentProof !== false) fail("GUEST_REPORT_INVALID", "Guest proof metadata differs from its declared scope.");
  if (guest.ok !== true) fail(guest.error?.code ?? "NATIVE_SETUP_INCOMPLETE", guest.error?.message ?? "Guest setup proof is incomplete.");
  if (guest.installationEvidence !== "verified-full-system-guest" || guest.runs?.length !== 2 || guest.sentinelCleanup !== true || guest.restrictionProbe?.exitCode !== 0 || guest.restrictionProbe?.result?.bounded_probe_passed !== true || guest.restrictionProbe?.result?.cleanup_complete !== true) fail("GUEST_REPORT_INVALID", "Successful guest report lacks completed repeat, restriction or cleanup evidence.");
  // Admission is always an independently reviewed later source change.
  report.installationEvidence = "verified-full-system-guest";
  report.ok = true;
}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--observe") { report.capabilities = capabilities(); fail("INFRASTRUCTURE_UNAVAILABLE", "Observation does not establish fresh guest execution or native readiness."); }
  if (process.env.FLEUR_OWNED_DISPOSABLE_HOST !== "yes") fail("OWNED_HOST_REQUIRED", "Explicit owned disposable host opt-in is required.");
  if (args.length !== 7 || args[0] !== "--run" || args[1] !== "--image" || args[3] !== "--candidate" || args[5] !== "--bun-archive") fail("ARGUMENT_INVALID", "Use --run --image <exact-image> --candidate source-owned --bun-archive <exact-Bun-zip>.");
  // A candidate archive supplied by a caller is never executed. Build from this source.
  if (args[4] !== "source-owned") {
    await authenticate(args[2]!, imagePin);
    fail("ARGUMENT_INVALID", "Candidate must be source-owned; arbitrary archives or profile overrides are refused.");
  }
  await execute(resolve(args[2]!), resolve(args[6]!));
} catch (error) {
  report.error = { code: (error as { code?: string }).code ?? "VERIFICATION_FAILED", message: error instanceof Error ? error.message : "Verification failed" };
  process.exitCode = 4;
} finally {
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
  if (scratch && stopped) {
    try { await rm(scratch, { recursive: true, force: true }); report.cleanup = { ownedVmReaped: true, credentialsRemoved: true }; }
    catch { report.ok = false; report.cleanupError = "Owned guest scratch cleanup failed."; process.exitCode = 5; }
  }
  process.stdout.write(JSON.stringify(report) + "\n");
}
