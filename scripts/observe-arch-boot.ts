import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import image from "./arch-boot-image.json";
import { authenticate, freePort } from "./verify-fresh-linux.ts";
import { disposeRecordedGuestArtifacts, interruptionTransport, retainInterruptionQmp } from "./verify-debian-recovery.ts";
import { ownedGuestSeed, attestOwnedGuestBoot, copyOwnedGuestBinding, copyOwnedGuestOsRelease } from "./owned-guest-seed.ts";
import { observeOwnedGuestCustody } from "./observe-owned-guest-custody.ts";
import { waitForGuestBoot } from "./observe-fresh-linux-boot.ts";

const repository = resolve(import.meta.dir, "..");
const flags = { installationVerified: false, nativeQualification: false, runtimeAdmission: false, humanConsentProof: false, nativeCpuPerformanceProof: false };
const report: Record<string, unknown> = { formatVersion: 1, scope: "source-owned-arch-kvm-boot-observation", ok: false, executed: false, ...flags };
const abort = new AbortController();
let scratch: string | undefined;
let vm: ReturnType<typeof Bun.spawn> | undefined;
let serial: Promise<string[]> | undefined;
let overlayHandle: Awaited<ReturnType<typeof open>> | undefined;
let qmp: Awaited<ReturnType<typeof retainInterruptionQmp>> | undefined;
const deadline = performance.now() + 900000;
const sources = ["scripts/observe-arch-boot.ts", "scripts/arch-boot-observation.py", "scripts/inspect-arch-image.py", "scripts/arch-boot-image.json", "scripts/qualify-debian-kvm.py", "scripts/native-kvm-host-tools.json", "scripts/verify-fresh-linux.ts", "scripts/verify-debian-recovery.ts", "scripts/owned-guest-seed.ts", "scripts/observe-owned-guest-custody.ts", "scripts/observe-fresh-linux-boot.ts", "scripts/retained-ssh.ts", "scripts/retained-ssh.py", "experiments/compatibility/runtime-probe/owned_guest.py"] as const;
const hash = (bytes: string | Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
async function bounded(stream: ReadableStream<Uint8Array>, limit = 2 * 1024 * 1024) {
  const parts: Uint8Array[] = []; let count = 0;
  for await (const part of stream) { count += part.length; if (count > limit) throw new Error("Arch observation output exceeded bound"); parts.push(part); }
  return Buffer.concat(parts).toString("utf8");
}
async function command(args: string[], budget = 30000) {
  if (abort.signal.aborted || performance.now() >= deadline) throw new Error("Original Arch observation deadline expired or cancelled");
  const child = Bun.spawn(args, { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: Math.min(budget, deadline - performance.now()), killSignal: "SIGKILL", env: { ...process.env, SSH_AUTH_SOCK: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined } });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]);
    if (exitCode !== 0 || performance.now() >= deadline || abort.signal.aborted) throw new Error(`Fixed Arch host command failed: ${args[0]} (${exitCode})`);
    return { stdout, stderr, exitCode };
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}
/** Fixed pattern names only: console text can contain bootstrap secrets. */
export function summarizeArchBootSerial(outputs: readonly string[]) {
  const patterns = [
    ["kernel-start", /Linux version [0-9]/],
    ["cloud-init-start", /Cloud-init v[. ].* running '/],
    ["cloud-init-finished", /Cloud-init v[. ].* finished at /],
    ["ssh-start", /Started .*Open(?:BSD )?SSH|Started .*SSH server|Starting .*Open(?:BSD )?SSH/],
    ["ssh-stop", /Stopped .*Open(?:BSD )?SSH|Stopped .*SSH server/],
    ["systemd-failure", /\[\s*FAILED\s*\]|Failed to start /],
    ["kernel-panic", /Kernel panic - not syncing/],
    ["python-traceback", /Traceback \(most recent call last\)/],
    ["cloud-init-warning", /cloud-init.*(?:WARNING|ERROR|failed)/],
  ] as const;
  return outputs.map((output) => {
    const matches: { line: number; pattern: string }[] = []; let total = 0;
    for (const [index, raw] of output.split("\n").entries()) {
      const line = raw.split(String.fromCharCode(27)).map((part, index) => index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")).join("");
      for (const [name, pattern] of patterns) if (pattern.test(line)) { total++; if (matches.length < 256) matches.push({ line: index + 1, pattern: name }); }
    }
    return { decodedUtf8Sha256: hash(output), decodedUtf8Bytes: Buffer.byteLength(output), patternMatches: matches, truncatedPatterns: total > matches.length };
  });
}
/** Retain a completed failed guest report before rejecting the observation. */
export async function collectArchObservation(options: { sshOptions: string[]; port: number; sourceSha256: string; binding: { nonce: string; bootId: string; uid: number; manifestSha256: string }; deadline: number; signal: AbortSignal }, result: Record<string, unknown>) {
  const binding = copyOwnedGuestBinding(options.binding, options.binding.nonce);
  if (!/^[a-f0-9]{64}$/.test(options.sourceSha256)) throw new Error("Fixed observer source digest required");
  const transport = await interruptionTransport(options.sshOptions, options.port, `/usr/bin/python3 -I /usr/local/lib/fleur-arch-boot-observation.py --observe ${binding.nonce} ${options.sourceSha256} ${binding.bootId} ${binding.manifestSha256}`, options.deadline, [0, 4], options.signal);
  result.observationTransport = { exitCode: transport.exitCode, stderrSha256: hash(transport.stderr), completed: true };
  const observed = JSON.parse(transport.stdout); result.observation = observed;
  if (transport.exitCode !== 0 || transport.stderr || observed.ok !== true) throw new Error("Fixed Arch guest observation failed");
  return observed;
}
async function execute(input: string) {
  if (process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() === 0 || process.env.FLEUR_GUEST_ACCELERATOR !== "kvm") throw new Error("Native ordinary Linux x64 KVM service required");
  const commit = (await command(["git", "rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || (await command(["git", "diff", "--exit-code", "HEAD"])).stdout) throw new Error("Clean committed source required");
  const files: Record<string, string> = {};
  for (const path of sources) {
    const tracked = await command(["git", "show", `${commit}:${path}`]);
    const actual = await readFile(join(repository, path));
    if (hash(tracked.stdout) !== hash(actual)) throw new Error("Tracked observation source differs");
    files[path] = hash(actual);
  }
  report.source = { commit, files };
  scratch = await mkdtemp(join(tmpdir(), "fleur-arch-boot-"));
  if (/[,\r\n]/.test(scratch) || Buffer.byteLength(join(scratch, "qmp.sock")) > 100) throw new Error("Private QEMU path cannot be represented safely");
  const base = join(scratch, "base.qcow2");
  await authenticate(input, { sha256: image.sha256, size: image.bytes }, base);
  report.toolchain = {};
  for (const tool of ["/usr/bin/qemu-img", "/usr/bin/qemu-system-x86_64", "/usr/bin/cloud-localds", "/usr/bin/ssh", "/usr/bin/ssh-keygen", "/usr/bin/python3"]) {
    const resolved = await import("node:fs/promises").then((fs) => fs.realpath(tool));
    const value = await lstat(resolved);
    if (!value.isFile() || value.uid !== 0 || (value.mode & 0o022) !== 0) throw new Error("Protected fixed tool unavailable");
    (report.toolchain as Record<string, unknown>)[tool] = { resolved, bytes: value.size, mode: value.mode & 0o7777, uid: value.uid, sha256: hash(await readFile(resolved)) };
  }
  const precheck = JSON.parse((await command(["/usr/bin/python3", "-I", join(repository, "scripts/inspect-arch-image.py"), "--image", base])).stdout);
  if (precheck.ok !== true || precheck.imageAuthenticated !== true || precheck.headerPrecheck !== true || precheck.fullStructureValidated !== false || precheck.sha256 !== image.sha256) throw new Error("Arch image precheck incomplete");
  const info = JSON.parse((await command(["/usr/bin/qemu-img", "info", "--output=json", "-f", "qcow2", base])).stdout);
  if (info.format !== "qcow2" || info["virtual-size"] !== image.virtualBytes || info["backing-filename"] || info["full-backing-filename"] || info["data-file"] || info.encrypted === true || info.snapshots?.length) throw new Error("Arch image structure differs");
  const check = JSON.parse((await command(["/usr/bin/qemu-img", "check", "--output=json", "-f", "qcow2", base], 60000)).stdout);
  if (check["check-errors"] !== 0 || (check.corruptions ?? 0) !== 0 || (check.leaks ?? 0) !== 0) throw new Error("Arch image check incomplete");
  report.image = { pin: image, precheck, info, check };
  const overlay = join(scratch, "overlay.qcow2");
  await command(["/usr/bin/qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", base, overlay]);
  overlayHandle = await open(overlay, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const originalOverlay = await overlayHandle.stat({ bigint: true });
  if (!originalOverlay.isFile() || originalOverlay.nlink !== 1n || originalOverlay.uid !== BigInt(process.getuid!())) throw new Error("Private overlay unavailable");
  const overlayIdentity = { dev: originalOverlay.dev.toString(), ino: originalOverlay.ino.toString() };
  const inspectOverlay = async () => {
    const held = await overlayHandle!.stat({ bigint: true }); const named = await lstat(overlay, { bigint: true });
    if (named.isSymbolicLink() || named.dev !== originalOverlay.dev || named.ino !== originalOverlay.ino || held.dev !== originalOverlay.dev || held.ino !== originalOverlay.ino || held.nlink !== 1n || vm?.exitCode !== null) throw new Error("Owned VM or held overlay continuity changed");
    return overlayIdentity;
  };
  const client = join(scratch, "client"); const host = join(scratch, "host");
  for (const key of [client, host]) await command(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
  const nonce = crypto.randomUUID(); const seed = await ownedGuestSeed(nonce, "arch-amd64");
  const observer = await readFile(join(repository, "scripts/arch-boot-observation.py"), "utf8");
  seed.write_files.push({ path: "/usr/local/lib/fleur-arch-boot-observation.py", owner: "root:root", permissions: "0444", content: observer });
  const seedDirectory = join(scratch, "seed-inputs"); await mkdir(seedDirectory, { mode: 0o700 });
  const userdata = "#cloud-config\n" + JSON.stringify({ users: [{ name: "fleur", groups: ["wheel"], sudo: "ALL=(ALL) NOPASSWD:ALL", shell: "/bin/bash", lock_passwd: true, ssh_authorized_keys: [(await readFile(client + ".pub", "utf8")).trim()] }], ssh_pwauth: false, disable_root: true,
    ssh_keys: { ed25519_private: await readFile(host, "utf8"), ed25519_public: (await readFile(host + ".pub", "utf8")).trim() }, ...seed, package_update: false, package_upgrade: false, growpart: { mode: "off" }, resize_rootfs: false });
  const metadata = JSON.stringify({ "instance-id": nonce, "local-hostname": "fleur-proof" });
  for (const [name, data] of [["user-data", userdata], ["meta-data", metadata]] as const) await writeFile(join(seedDirectory, name), data, { flag: "wx", mode: 0o600 });
  const seedImage = join(scratch, "seed.img");
  await command(["/usr/bin/cloud-localds", seedImage, join(seedDirectory, "user-data"), join(seedDirectory, "meta-data")]);
  report.seed = { userdataSha256: hash(userdata), metadataSha256: hash(metadata), imageSha256: hash(await readFile(seedImage)), bootstrapOnly: true, growpart: false, resizeRootfs: false };
  const port = await freePort(); const knownHosts = join(scratch, "known_hosts");
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${(await readFile(host + ".pub", "utf8")).trim()}\n`, { flag: "wx", mode: 0o600 });
  const qmpPath = join(scratch, "qmp.sock");
  vm = Bun.spawn(["/usr/bin/qemu-system-x86_64", "-name", `fleur-${nonce}`, "-machine", "q35", "-accel", "kvm", "-cpu", "host", "-smp", "2", "-m", "3072", "-display", "none", "-monitor", "none", "-serial", "stdio", "-qmp", `unix:${qmpPath},server=on,wait=off`, "-drive", `file=${overlay},format=qcow2,if=virtio`, "-drive", `file=${seedImage},format=raw,if=virtio,readonly=on`, "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${port}-:22`, "-device", "virtio-net-pci,netdev=net0"], { cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  report.executed = true;
  serial = Promise.all([bounded(vm.stdout as ReadableStream<Uint8Array>), bounded(vm.stderr as ReadableStream<Uint8Array>)]);
  void serial.catch(() => { if (vm?.exitCode === null) vm.kill("SIGKILL"); });
  const bootAbort = new AbortController();
  const cancelBoot = () => bootAbort.abort(); abort.signal.addEventListener("abort", cancelBoot, { once: true });
  void vm.exited.then(cancelBoot, cancelBoot);
  const bootDeadline = Math.min(deadline, performance.now() + 180000);
  const target = { port, identity: client, knownHosts, nonce };
  try {
    const boot = await waitForGuestBoot(target, { deadline: bootDeadline, signal: bootAbort.signal }); report.boot = boot;
    if (!boot.ok || vm.exitCode !== null) throw new Error("Arch boot did not establish clean cloud-init readiness");
  } finally { abort.signal.removeEventListener("abort", cancelBoot); }
  qmp = await retainInterruptionQmp(qmpPath, `fleur-${nonce}`, deadline, abort.signal, true);
  const custody = async () => attestOwnedGuestBoot({ nonce, deadline, query: (_remote, budget) => observeOwnedGuestCustody(target, budget, abort.signal) });
  const original = await custody(); const binding = copyOwnedGuestBinding({ nonce, bootId: original.bootId, uid: original.uid, manifestSha256: original.manifestSha256 }, nonce);
  const os = copyOwnedGuestOsRelease(original.osRelease);
  if (os.id !== "arch" || os.versionId !== null || os.buildId !== "rolling") throw new Error("Raw Arch OS record differs");
  report.custody = { binding, osRelease: os, before: original, overlay: await inspectOverlay(), qmpBefore: await qmp.inspect(overlay), pinnedHostKey: true };
  const sshOptions = ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", client];
  const observed = await collectArchObservation({ sshOptions, port, sourceSha256: hash(observer), binding, deadline: Math.min(deadline, performance.now() + 125000), signal: abort.signal }, report);
  if (observed.scope !== "fixed-arch-read-only-boot-observation" || observed.custodyPreserved !== true || observed.sourceSha256 !== hash(observer) || observed.binding?.nonce !== nonce || observed.binding?.bootId !== binding.bootId || observed.binding?.uid !== binding.uid || observed.binding?.manifestSha256 !== binding.manifestSha256 || Object.entries(flags).some(([key, value]) => observed[key] !== value)) throw new Error("Fixed Arch observation did not retain source and custody");
  const expectedCommands = ["package-inventory", "pacman-version", "runtime-packages", "database-check", ...["RootDir", "DBPath", "GPGDir", "HookDir", "LocalFileSigLevel"].map((name) => `pacman-conf-${name}`), "mounts", "disks", ...["docker.service", "docker.socket", "containerd.service", "nftables.service"].map((name) => `unit-${name}`), ...["/etc/pacman.conf", "/etc/nftables.conf", "/usr/lib/systemd/system/nftables.service", "/usr/bin/nft"].map((name) => `owner-${name}`)];
  if (!Array.isArray(observed.commands) || observed.commands.length !== expectedCommands.length || expectedCommands.some((name) => observed.commands.filter((entry: Record<string, unknown>) => entry.name === name && entry.completed === true && entry.processGroupRetired === true).length !== 1)) throw new Error("Arch query ledger is incomplete");
  const after = await custody();
  if (after.bootId !== original.bootId || after.manifestSha256 !== original.manifestSha256 || after.uid !== original.uid || JSON.stringify(after.osRelease) !== JSON.stringify(original.osRelease)) throw new Error("Arch custody changed after read-only observation");
  (report.custody as Record<string, unknown>).after = after;
  (report.custody as Record<string, unknown>).qmpAfter = await qmp.inspect(overlay);
  await inspectOverlay();
  if (!qmp.alive()) throw new Error("Continuous Arch VM witness unavailable");
  report.accelerator = "kvm"; report.ok = true;
}
if (import.meta.main) {
  const cancel = () => abort.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    if (process.env.FLEUR_OWNED_DISPOSABLE_HOST !== "yes") throw new Error("Explicit owned disposable host required");
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== "--run" || args[1] !== "--image" || !args[2]) throw new Error("Use --run --image with the fixed authenticated Arch image");
    await execute(resolve(args[2]));
  } catch (error) { report.ok = false; report.error = { message: error instanceof Error ? error.message : "Arch observation failed" }; }
  finally {
    qmp?.close();
    let descriptorUncertain = false;
    let reaped = !vm;
    if (vm) {
      try { if (vm.exitCode === null) vm.kill("SIGTERM"); await Promise.race([vm.exited, new Promise((done) => setTimeout(done, 3000))]); if (vm.exitCode === null) vm.kill("SIGKILL"); await vm.exited; reaped = true; report.serialSummary = summarizeArchBootSerial(await serial ?? []); }
      catch { report.ok = false; }
    }
    try { await overlayHandle?.close(); } catch { descriptorUncertain = true; report.ok = false; }
    if (scratch) await disposeRecordedGuestArtifacts(report, scratch, reaped, descriptorUncertain);
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    process.stdout.write(JSON.stringify(report) + "\n"); process.exitCode = report.ok ? 0 : 4;
  }
}
