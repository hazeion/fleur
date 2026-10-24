import { constants } from "node:fs";
/** Private disposable-Linux filesystem/privileged-read conformance. No admission. */
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const packageRoot = resolve(process.argv[2] ?? '');
assert(process.argv.length === 7 && process.platform === 'linux' && process.arch === 'x64' && process.getuid!() > 0);
assert(packageRoot.startsWith(process.env.HOME + '/lab/'));
const binding = { nonce: process.argv[3]!, bootId: process.argv[4]!, uid: Number(process.argv[5]), manifestSha256: process.argv[6]! };
assert(/^[a-f0-9-]{36}$/.test(binding.nonce) && /^[a-f0-9-]{36}$/.test(binding.bootId) && binding.uid === process.getuid!() && /^[a-f0-9]{64}$/.test(binding.manifestSha256));
const sourcePath = join(packageRoot, 'src/setup/apt-auxiliary.ts');
const source = await readFile(sourcePath, 'utf8');
const { retainAptAuxiliaries } = await import(pathToFileURL(sourcePath).href);
const { productionHost } = await import(pathToFileURL(join(packageRoot, 'src/setup/host.ts')).href);
const { selectNativeProfile, nativeInstallProfiles } = await import(pathToFileURL(join(packageRoot, 'src/setup/native.ts')).href);
const base = productionHost(); const identity = await base.host(); const profile = selectNativeProfile(identity, nativeInstallProfiles);
assert(identity.system === 'linux' && identity.translated === false && identity.distribution === 'debian' && identity.release === '13' && profile?.method === 'docker-official-apt');
const root = await mkdtemp(join(dirname(packageRoot), 'apt-inspector-conformance-'));
const deadline = performance.now() + 100000;
const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
const report: Record<string, unknown> = { formatVersion: 1, scope: 'owned-native-apt-inspector-conformance', ok: false, runtimeAdmission: false, humanConsentProof: false, sourceSha256: Bun.CryptoHasher.hash('sha256', source, 'hex'), fixturesRetainedForVmDisposal: true, cases: [] };
const cases: Record<string, unknown>[] = [];
async function checkOwnedBinding() {
  const path = '/usr/local/lib/fleur-owned-guest.py';
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let body: Buffer;
  try {
    const info = await file.stat({ bigint: true }); assert(info.isFile() && info.uid === 0n && info.nlink === 1n && (info.mode & 0o7777n) === 0o444n && info.size > 0n && info.size <= 32768n);
    const bytes = Buffer.alloc(Number(info.size) + 1); let used = 0;
    while (used < bytes.length) { assert(remaining() > 0); const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    body = bytes.subarray(0, used); assert(BigInt(used) === info.size && Bun.CryptoHasher.hash('sha256', body, 'hex') === 'aeab923bf41a4c830ed4752e3501b36262896c25eb4cff118fff9709f81bafc3');
    const after = await file.stat({ bigint: true }); const named = await lstat(path, { bigint: true });
    const fields = (value: typeof info) => [value.dev,value.ino,value.uid,value.mode,value.nlink,value.size,value.mtimeNs,value.ctimeNs].map(String).join(':');
    assert(fields(info) === fields(after) && fields(info) === fields(named));
  } finally { await file.close(); }
  const code = '__file__ = ' + JSON.stringify(path) + '; exec(compile(' + JSON.stringify(body.toString()) + ', __file__, "exec"), globals())';
  const result = await base.run(['/usr/bin/python3','-I','-c',code,'--owned-guest-nonce',binding.nonce,'--budget-seconds','5'],Math.min(5000,remaining()));
  assert(result.status === 'completed' && result.exitCode === 0 && !result.terminationUnconfirmed && result.stderr === '');
  const observed = JSON.parse(result.stdout);
  assert(observed.formatVersion === 1 && observed.scope === 'owned-guest-custody-validation' && observed.ok === true && observed.fixtureCustodyValidated === true && observed.nonce === binding.nonce && observed.bootId === binding.bootId && observed.uid === binding.uid && observed.manifestSha256 === binding.manifestSha256 && observed.runtimeAdmission === false && observed.humanConsentProof === false && observed.osRelease?.id === 'debian' && observed.osRelease?.versionId === '13');
  report.ownedGuestCustody = observed;
}

let sequence = 0;
async function fixture(nonempty = false) {
  const directory = join(root, 'case-' + ++sequence); await mkdir(directory, { mode: 0o700 });
  const stage = 'apt-payloads-fixture'; const stagePath = join(directory, stage);
  await mkdir(stagePath, { mode: 0o700 });
  const paths = ['.', 'archives', 'local-lists', 'archives/partial', 'local-lists/auxfiles'];
  for (const [index, path] of paths.entries()) {
    if (index !== 0) await mkdir(join(stagePath, path), { mode: index === 2 || index === 4 ? 0o755 : 0o700 });
    await chmod(join(stagePath, path), index === 2 || index === 4 ? 0o755 : 0o700);
  }
  const entries = await Promise.all(paths.map(async (path, index) => { const info = await lstat(join(stagePath, path), { bigint: true }); return { path, dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), mode: Number(info.mode & 0o7777n), directory: true, auxiliary: index >= 3 }; }));
  if (nonempty) await writeFile(join(stagePath, 'archives/partial/sentinel'), 'preserve controlled conformance evidence\n', { flag: 'wx', mode: 0o600 });
  // This fixture-only preparation changes only freshly allocated conformance
  // directories. It never repairs or touches the original installation stage.
  await checkOwnedBinding();
  const changed = await base.run(['/usr/bin/sudo', '-n', '/usr/bin/chown', '--no-dereference', '_apt:root', '--', join(stagePath, 'archives/partial'), join(stagePath, 'local-lists/auxfiles')], Math.min(5000, remaining()));
  assert(changed.status === 'completed' && changed.exitCode === 0 && !changed.terminationUnconfirmed);
  return { directory, stagePath, manifest: { root: stage, entries } };
}
function wrapper(kind: string, state: { calls: number; request?: { directories: { fd: number; metadata: { dev: string; ino: string } }[] }; actualCompleted?: boolean }) {
  return { ...base, run: async (args: readonly string[], timeout: number, context?: unknown) => {
    if (args[0] !== '/usr/bin/sudo' || !args.includes('-e')) return base.run(args, timeout, context);
    state.calls++;
    const changed = [...args]; const request = JSON.parse(changed.at(-1)!); state.request = request;
    if (kind === 'account-digest') request.accountSha256 = 'f'.repeat(64);
    if (kind === 'parent-start') request.parentStart = String(BigInt(request.parentStart) + 1n);
    if (kind === 'descriptor') request.directories[3].fd = request.directories[4].fd;
    changed[changed.length - 1] = JSON.stringify(request);
    const observed = await base.run(changed, timeout, context);
    if (kind === 'lost-completion') {
      // Independently finish/reap actual privileged work before withholding its
      // completion from the product. The negative control never has live work.
      assert(observed.status === 'completed' && observed.exitCode === 0 && !observed.terminationUnconfirmed);
      state.actualCompleted = true;
      throw new Error('Controlled loss of a completed privileged-read observation');
    }
    return observed;
  } };
}
async function attempt(kind: string, implementation = retainAptAuxiliaries) {
  const value = await fixture(kind === 'nonempty');
  const state: { calls: number; request?: { directories: { fd: number; metadata: { dev: string; ino: string } }[] }; actualCompleted?: boolean } = { calls: 0 };
  const custody = await implementation(wrapper(kind, state), value.directory, value.manifest, profile, remaining);
  assert(custody.request !== null);
  if (report.inspectorSha256 !== undefined) assert(report.inspectorSha256 === custody.inspectorSha256);
  report.inspectorSha256 = custody.inspectorSha256;
  if (kind === 'inode' || kind === 'link') {
    await rename(join(value.stagePath, 'archives/partial'), join(value.stagePath, 'archives/original-partial'));
    if (kind === 'inode') await mkdir(join(value.stagePath, 'archives/partial'), { mode: 0o700 });
    else await symlink(join(value.stagePath, 'local-lists/auxfiles'), join(value.stagePath, 'archives/partial'));
  }
  let succeeded = false; let stage: string | undefined;
  try {
    const observed = await custody.inspect(remaining); await custody.verifyReceipt(observed); await custody.unchanged(); succeeded = true;
  } catch (error) { stage = (error as { outcome?: { result?: { data?: { inspection?: { stage?: string } } } } }).outcome?.result?.data?.inspection?.stage; }
  finally { await custody.close(); }
  if (kind === 'empty') { assert(succeeded && state.calls === 1); return { case: kind, emptyVerified: true, privilegedReadCompleted: true }; }
  assert(!succeeded);
  if (kind === 'lost-completion') {
    assert(state.actualCompleted && state.request?.directories.length === 5);
    const retained = await Promise.all(state.request.directories.map(async (item) => {
      try { const info = await stat('/proc/self/fd/' + item.fd, { bigint: true }); return String(info.dev) === item.metadata.dev && String(info.ino) === item.metadata.ino; } catch { return false; }
    }));
    return { case: kind, actualReadRetired: true, descriptorsRetained: retained.every(Boolean) };
  }
  if (kind === 'inode' || kind === 'link') assert(state.calls === 0);
  else { assert(state.calls === 1); assert(stage === (kind === 'account-digest' ? 'account' : kind === 'descriptor' ? 'directories' : kind === 'nonempty' ? 'contents' : 'invocation')); }
  return { case: kind, expectedRefusal: true, privilegedReads: state.calls, stage };
}
try {
  for (const kind of ['empty', 'nonempty', 'inode', 'link', 'account-digest', 'parent-start', 'descriptor']) cases.push(await attempt(kind));
  const retained = await attempt('lost-completion'); assert(retained.descriptorsRetained === true); cases.push(retained);
  // Recreate precisely the reviewed lifecycle bug in a private diagnostic module.
  // Its actual read has retired before the withheld completion is thrown.
  let counterfactual = source;
  const old = '      inspectionUnconfirmed = true;\n      const result = await host.run';
  assert(counterfactual.split(old).length === 2);
  counterfactual = counterfactual.replace(old, '      const result = await host.run');
  for (const specifier of ['../cli/result.ts','../cli/catalog.ts','./commands.ts','./grants.ts','./native.ts','./apt-service.ts','./apt-inspector.ts']) {
    counterfactual = counterfactual.replaceAll(JSON.stringify(specifier), JSON.stringify(pathToFileURL(resolve(dirname(sourcePath), specifier)).href));
  }
  const counterfactualPath = join(root, 'apt-auxiliary-lifecycle-counterfactual.ts');
  await writeFile(counterfactualPath, counterfactual, { flag: 'wx', mode: 0o600 });
  const broken = await import(pathToFileURL(counterfactualPath).href);
  const refused = await attempt('lost-completion', broken.retainAptAuxiliaries); assert(refused.descriptorsRetained === false);
  cases.push({ case: 'lost-completion-negative-control', defectObserved: true, actualReadRetired: true, sourceSha256: Bun.CryptoHasher.hash('sha256', counterfactual, 'hex') });
  report.cases = cases; report.ok = true;
} catch (error) { report.cases = cases; report.error = error instanceof Error ? error.message : 'Conformance failed'; process.exitCode = 5; }
finally { process.stdout.write(JSON.stringify(report) + '\n'); }
