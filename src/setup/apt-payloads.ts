import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { AptInstallProfile } from "./native.ts";
import { aptCacheArchiveFilename, aptPackageArtifacts } from "./apt-dependencies.ts";
import type { HostCommandContext, HostCommandResult, SetupHost } from "./commands.ts";
import { syncStateDirectory } from "./lock.ts";

export class AptPayloadUnavailable extends Error {}
export class AptPayloadRecovery extends Error {}
interface Identity { readonly dev: bigint; readonly ino: bigint; readonly directory: boolean; readonly sha256?: string; readonly size?: number }
export interface AptRetainedEntry {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly directory: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly auxiliary: boolean;
  readonly size?: number;
  readonly sha256?: string;
}
export interface AptRetainedArtifacts { readonly root: string; readonly entries: readonly AptRetainedEntry[] }
/** Exact owned temporary entries; unknown or replaced content is retained, never recursively deleted. */
export class AptPayloadStage {
  readonly paths: string[] = [];
  readonly archivePaths: string[] = [];
  private readonly cacheNodes = new Map<string, { readonly mode: bigint; readonly auxiliary: boolean }>();
  private localInputs?: { list: string; config: string; parts: string };
  private readonly entries = new Map<string, Identity>();
  private constructor(readonly root: string) {}
  static async create(directory: string): Promise<AptPayloadStage> {
    const stage = new AptPayloadStage(await mkdtemp(join(directory, "apt-payloads-")));
    await stage.bind(stage.root, true);
    return stage;
  }
  private async bind(path: string, directory: boolean): Promise<void> {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== BigInt(process.getuid!()) || (!directory && info.nlink !== 1n)) throw new AptPayloadRecovery("Unsafe private artifact entry");
    this.entries.set(path, { dev: info.dev, ino: info.ino, directory });
  }
  async unchanged(path: string): Promise<void> {
    const expected = this.entries.get(path);
    const info = await lstat(path, { bigint: true });
    if (!expected || info.dev !== expected.dev || info.ino !== expected.ino || info.isSymbolicLink() || (expected.directory ? !info.isDirectory() : !info.isFile()) || info.uid !== BigInt(process.getuid!())) throw new AptPayloadRecovery("Private artifact identity changed");
  }
  async writeOwned(name: string, bytes: Uint8Array): Promise<string> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new AptPayloadRecovery("Unsafe internal artifact name");
    await this.unchanged(this.root);
    const path = join(this.root, name);
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await this.bind(path, false);
    this.entries.set(path, { ...this.entries.get(path)!, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"), size: bytes.length });
    return path;
  }
  async fileIdentity(path: string): Promise<{ readonly dev: string; readonly ino: string }> {
    await this.unchanged(path);
    const identity = this.entries.get(path)!;
    return { dev: String(identity.dev), ino: String(identity.ino) };
  }
  private async digest(path: string, size: number, remaining: () => number, mode?: bigint): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      const identity = this.entries.get(path)!;
      if (!info.isFile() || (mode !== undefined && (info.mode & 0o777n) !== mode) || info.uid !== BigInt(process.getuid!()) || info.nlink !== 1n || info.size !== BigInt(size) || info.dev !== identity.dev || info.ino !== identity.ino) throw new AptPayloadRecovery("Archive descriptor identity or size changed");
      const hash = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let total = 0;
      while (total <= size) {
        if (remaining() <= 0) throw new AptPayloadUnavailable("The archive verification deadline expired");
        const read = await file.read(buffer, 0, Math.min(buffer.length, size + 1 - total));
        if (!read.bytesRead) break;
        total += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead));
      }
      if (total !== size) throw new AptPayloadRecovery("Archive size changed while hashing");
      return hash.digest("hex");
    } finally { await file.close(); }
  }
  async prepareLocalSources(options: readonly string[]): Promise<readonly string[]> {
    const list = await this.writeOwned("local-only.list", new Uint8Array());
    const config = await this.writeOwned("local-only.conf", Buffer.from("#clear APT::Sources::With;\n"));
    const parts = join(this.root, "local-only.parts");
    await this.unchanged(this.root);
    await mkdir(parts, { mode: 0o700 }); await this.bind(parts, true);
    this.localInputs = { list, config, parts };
    return ["-c", config, ...options.map((option) => option.startsWith("Dir::Etc::sourcelist=") ? `Dir::Etc::sourcelist=${list}` : option.startsWith("Dir::Etc::sourceparts=") ? `Dir::Etc::sourceparts=${parts}` : option)];
  }
  async verifyLocalSources(remaining: () => number): Promise<void> {
    if (!this.localInputs) throw new AptPayloadRecovery("Local APT sources are unavailable");
    await this.unchanged(this.root);
    const { list, config, parts } = this.localInputs;
    for (const [path, bytes] of [[list, Buffer.alloc(0)], [config, Buffer.from("#clear APT::Sources::With;\n")]] as const) {
      await this.unchanged(path);
      if (await this.digest(path, bytes.length, remaining, 0o600n) !== Bun.CryptoHasher.hash("sha256", bytes, "hex")) throw new AptPayloadRecovery("Local APT source bytes changed");
      await this.unchanged(path);
    }
    await this.unchanged(parts);
    const held = await open(parts, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await held.stat({ bigint: true }); const expected = this.entries.get(parts)!;
      if (!info.isDirectory() || info.uid !== BigInt(process.getuid!()) || info.dev !== expected.dev || info.ino !== expected.ino || (info.mode & 0o777n) !== 0o700n) throw new AptPayloadRecovery("Local APT source directory changed");
      if (remaining() <= 0) throw new AptPayloadUnavailable("The local source verification deadline expired");
      const directory = await opendir(parts);
      try { if (await directory.read() !== null) throw new AptPayloadRecovery("Local APT source directory is not empty"); }
      finally { await directory.close(); }
      await this.unchanged(parts); await this.unchanged(this.root);
    } finally { await held.close(); }
  }
  async prepareArchiveCache(host: SetupHost, profile: AptInstallProfile, missing: readonly string[], remaining: () => number): Promise<readonly string[]> {
    const archives = join(this.root, "archives"); const lists = join(this.root, "local-lists");
    for (const [path, mode, auxiliary] of [[archives, 0o700, false], [join(archives, "partial"), 0o700, true], [lists, 0o755, false], [join(lists, "auxfiles"), 0o755, true]] as const) {
      await this.unchanged(this.root); await this.unchanged(dirname(path));
      await mkdir(path, { mode }); await this.bind(path, true);
      const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const info = await directory.stat({ bigint: true }); const bound = this.entries.get(path)!;
        if (info.dev !== bound.dev || info.ino !== bound.ino || !info.isDirectory() || info.uid !== BigInt(process.getuid!())) throw new AptPayloadRecovery("Cache directory changed during creation");
        await directory.chmod(mode);
      } finally { await directory.close(); }
      await this.unchanged(path); await this.unchanged(dirname(path));
      this.cacheNodes.set(path, { mode: BigInt(mode), auxiliary });
    }
    const lock = join(archives, "lock");
    const heldLock = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await this.bind(lock, false);
      const info = await heldLock.stat({ bigint: true }); const bound = this.entries.get(lock)!;
      if (!info.isFile() || info.dev !== bound.dev || info.ino !== bound.ino || info.uid !== BigInt(process.getuid!()) || info.nlink !== 1n || info.size !== 0n) throw new AptPayloadRecovery("Private archive lock identity changed during creation");
      await heldLock.sync();
    } finally { await heldLock.close(); }
    this.entries.set(lock, { ...this.entries.get(lock)!, size: 0, sha256: Bun.CryptoHasher.hash("sha256", new Uint8Array(), "hex") });
    this.cacheNodes.set(lock, { mode: 0o600n, auxiliary: false });
    for (const [index, name] of missing.entries()) {
      const artifact = aptPackageArtifacts(profile)[name]!; const source = this.paths[index]!;
      await this.verify(source, profile, name, remaining);
      const path = join(archives, aptCacheArchiveFilename(artifact));
      await this.unchanged(archives);
      const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await input.stat({ bigint: true }); const expected = this.entries.get(source)!;
        if (!info.isFile() || info.nlink !== 1n || info.uid !== BigInt(process.getuid!()) || info.dev !== expected.dev || info.ino !== expected.ino || info.size !== BigInt(artifact.size)) throw new AptPayloadRecovery("Source archive changed before cache copy");
        const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const created = await output.stat({ bigint: true });
          await this.bind(path, false);
          const bound = this.entries.get(path)!;
          if (!created.isFile() || created.nlink !== 1n || created.uid !== BigInt(process.getuid!()) || created.size !== 0n || created.dev !== bound.dev || created.ino !== bound.ino) throw new AptPayloadRecovery("Archive copy destination identity changed");
          this.cacheNodes.set(path, { mode: 0o600n, auxiliary: false });
          const buffer = Buffer.alloc(65536); let total = 0;
          while (total <= artifact.size) {
            if (remaining() <= 0) throw new AptPayloadUnavailable("The archive copy deadline expired");
            const read = await input.read(buffer, 0, Math.min(buffer.length, artifact.size + 1 - total), total);
            if (!read.bytesRead) break;
            if (total + read.bytesRead > artifact.size) throw new AptPayloadRecovery("Source archive grew during cache copy");
            let written = 0;
            while (written < read.bytesRead) {
              const next = await output.write(buffer, written, read.bytesRead - written, total + written);
              if (!next.bytesWritten) throw new AptPayloadRecovery("Archive cache copy made no progress");
              written += next.bytesWritten;
            }
            total += read.bytesRead;
          }
          if (total !== artifact.size) throw new AptPayloadRecovery("Source archive shortened during cache copy");
          await output.sync();
        } finally { await output.close(); }
      } finally { await input.close(); }
      await this.verify(source, profile, name, remaining);
      await this.verify(path, profile, name, remaining);
      if (remaining() <= 0) throw new AptPayloadUnavailable("The archive control verification deadline expired");
      const metadata = await host.run(["dpkg-deb", "--field", path, "Package", "Version", "Architecture"], remaining());
      const fields = Object.fromEntries(metadata.stdout.trim().split("\n").map((line) => { const separator = line.indexOf(": "); return [line.slice(0, separator), line.slice(separator + 2)]; }));
      if (metadata.status !== "completed" || metadata.exitCode !== 0 || metadata.terminationUnconfirmed || metadata.stdout.trim().split("\n").length !== 3 || Object.keys(fields).length !== 3 || fields.Package !== name || fields.Version !== artifact.version || fields.Architecture !== artifact.architecture) throw new AptPayloadUnavailable("The cached archive control identity does not match its frozen package tuple");
      this.archivePaths.push(path);
    }
    await this.verifyArchiveCache(remaining);
    return ["-o", `Dir::Cache::Archives=${archives}/`, "-o", `Dir::State::lists=${lists}/`];
  }
  private async verifyEntries(remaining: () => number, terminalAuxiliary = false): Promise<void> {
    for (const [path, identity] of this.entries) {
      const node = this.cacheNodes.get(path);
      if (terminalAuxiliary && node?.auxiliary) {
        const info = await lstat(path, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino || (info.mode & 0o7777n) !== node.mode) throw new AptPayloadRecovery("APT auxiliary directory identity changed");
        continue; // Only identity-checked empty rmdir may remove this original inode.
      }
      await this.unchanged(path);
      if (node && ((await lstat(path, { bigint: true })).mode & 0o7777n) !== node.mode) throw new AptPayloadRecovery("APT cache entry mode changed");
      if (identity.directory) {
        const expectedChildren = [...this.entries.keys()].filter((entry) => dirname(entry) === path).length;
        const directory = await opendir(path);
        try {
          let count = 0;
          while (true) {
            if (remaining() <= 0) throw new AptPayloadUnavailable("The archive stage verification deadline expired");
            const entry = await directory.read(); if (!entry) break;
            if (++count > expectedChildren || !this.entries.has(join(path, entry.name))) throw new AptPayloadRecovery("Private archive stage contains unknown entries");
          }
        } finally { await directory.close(); }
        await this.unchanged(path);
      } else if (identity.sha256 === undefined || identity.size === undefined || await this.digest(path, identity.size, remaining) !== identity.sha256) throw new AptPayloadRecovery("Private archive stage bytes changed");
    }
  }
  async verifyArchiveCache(remaining: () => number): Promise<void> {
    await this.unchanged(this.root);
    if (((await lstat(this.root, { bigint: true })).mode & 0o7777n) !== 0o700n) throw new AptPayloadRecovery("Private archive stage mode changed");
    await this.verifyEntries(remaining);
  }
  /** Persist exact identities before privileged execution; names alone never grant later ownership. */
  async recoveryManifest(remaining: () => number, syncDirectory: (directory: string) => Promise<void> = syncStateDirectory): Promise<AptRetainedArtifacts> {
    await this.verifyArchiveCache(remaining);
    const entries: AptRetainedEntry[] = [];
    for (const [path, identity] of [...this.entries].reverse()) {
      if (remaining() <= 0) throw new AptPayloadRecovery("The artifact durability deadline expired");
      await this.unchanged(path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (identity.directory ? constants.O_DIRECTORY : 0));
      try {
        const info = await file.stat({ bigint: true });
        if (info.dev !== identity.dev || info.ino !== identity.ino || info.uid !== BigInt(process.getuid!()) || (identity.directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n)) throw new AptPayloadRecovery("Artifact identity changed before recovery publication");
        try { if (identity.directory) await syncDirectory(path); else await file.sync(); }
        catch { throw new AptPayloadRecovery("Private artifact durability could not be confirmed"); }
        entries.push({ path: relative(this.root, path) || ".", dev: String(info.dev), ino: String(info.ino), directory: identity.directory, uid: Number(info.uid), mode: Number(info.mode & 0o7777n), auxiliary: this.cacheNodes.get(path)?.auxiliary === true, ...(!identity.directory ? { size: identity.size!, sha256: identity.sha256! } : {}) });
      } finally { await file.close(); }
    }
    await this.verifyArchiveCache(remaining);
    return { root: basename(this.root), entries: entries.sort((left, right) => left.path.localeCompare(right.path)) };
  }
  async finishArchiveCache(remaining: () => number, terminalInstall: boolean): Promise<void> {
    await this.unchanged(this.root);
    if (((await lstat(this.root, { bigint: true })).mode & 0o7777n) !== 0o700n) throw new AptPayloadRecovery("Private archive stage mode changed");
    await this.verifyEntries(remaining, terminalInstall);
    for (const [path, node] of this.cacheNodes) {
      if (!node.auxiliary) continue;
      await this.unchanged(dirname(path));
      const info = await lstat(path, { bigint: true }); const expected = this.entries.get(path)!;
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev || info.ino !== expected.ino || (info.mode & 0o7777n) !== node.mode || (!terminalInstall && info.uid !== BigInt(process.getuid!()))) throw new AptPayloadRecovery("APT auxiliary directory changed before cleanup");
      try { await rmdir(path); } catch { throw new AptPayloadRecovery("APT auxiliary directory could not be safely removed"); }
      this.entries.delete(path); this.cacheNodes.delete(path);
    }
  }
  async cleanup(): Promise<boolean> {
    try {
      await this.verifyEntries(() => 1);
      for (const [path, identity] of [...this.entries].reverse()) {
        await this.unchanged(path);
        if (identity.directory) await rmdir(path); else await unlink(path);
      }
      return true;
    } catch { return false; }
  }
  async acquire(host: SetupHost, profile: AptInstallProfile, missing: readonly string[], options: readonly string[], remaining: () => number, authorize: () => Promise<void>): Promise<void> {
    const run = async (args: readonly string[], context?: HostCommandContext): Promise<HostCommandResult> => {
      if (remaining() <= 0) return { status: "timeout", stdout: "", stderr: "" };
      try { return await host.run(args, remaining(), context); }
      catch { throw new AptPayloadRecovery("The artifact invocation completion could not be observed"); }
    };
    for (const name of missing) {
      const artifact = aptPackageArtifacts(profile)[name];
      if (!artifact) throw new AptPayloadUnavailable("The package is outside its declared artifact closure");
      await this.unchanged(this.root);
      const directory = join(this.root, name);
      await mkdir(directory, { mode: 0o700 });
      await this.bind(directory, true);
      if (Object.hasOwn(profile.distroDependencies?.artifacts ?? {}, name)) {
        const path = join(directory, basename(new URL(artifact.url).pathname));
        await authorize();
        await this.unchanged(directory);
        let output: Awaited<ReturnType<typeof open>> | undefined;
        let acquisitionError: unknown;
        try {
          output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
          await this.bind(path, false);
          const created = await output.stat({ bigint: true }); const claimed = this.entries.get(path)!;
          if (!created.isFile() || created.uid !== BigInt(process.getuid!()) || created.nlink !== 1n || (created.mode & 0o7777n) !== 0o600n || created.size !== 0n || created.dev !== claimed.dev || created.ino !== claimed.ino) throw new AptPayloadRecovery("The exclusive dependency output claim changed");
          const downloaded = await run(["curl", "--disable", "--fail", "--proto", "=https", "--tlsv1.2", "--max-redirs", "0", "--max-filesize", String(artifact.size), "--output", "-", artifact.url], { cwd: directory, cleanEnvironment: true, artifactOutput: { descriptor: output.fd, maxBytes: artifact.size } });
          if (downloaded.status !== "completed" && downloaded.status !== "missing" || downloaded.terminationUnconfirmed) throw new AptPayloadRecovery("Dependency acquisition has no confirmed terminal result");
          await this.unchanged(directory); await this.unchanged(path);
          const entries = await readdir(directory);
          if (entries.length !== 1 || entries[0] !== basename(path)) throw new AptPayloadRecovery("Dependency acquisition produced unknown private entries");
          if (downloaded.status === "missing") {
            this.entries.set(path, { ...claimed, size: 0, sha256: Bun.CryptoHasher.hash("sha256", new Uint8Array(), "hex") });
            throw new AptPayloadUnavailable("The existing curl tool is required to acquire declared Debian dependencies; no tool was installed");
          }
          if (downloaded.exitCode !== 0) throw new AptPayloadUnavailable("The declared Debian dependency download did not complete");
          await output.sync();
        } catch (error) {
          acquisitionError = error instanceof AptPayloadRecovery || error instanceof AptPayloadUnavailable ? error : new AptPayloadRecovery("The exclusive dependency output is unavailable or changed");
        }
        if (output) { try { await output.close(); } catch { acquisitionError = new AptPayloadRecovery("The dependency output descriptor could not be retired"); } }
        if (acquisitionError) throw acquisitionError;
        await this.verify(path, profile, name, remaining);
        await this.verifyControl(host, path, artifact, remaining);
        this.paths.push(path);
        continue;
      }
      const target = `${name}=${artifact.version}`;
      const resolved = await run(["apt-get", ...options, "--print-uris", "download", target], { cwd: directory });
      if (resolved.status === "timeout" || resolved.terminationUnconfirmed) throw new AptPayloadRecovery("The artifact URI resolution has no confirmed terminal result");
      // APT 2.8 encodes +, ~ and percent in the repository path before printing its URI.
      const frozenUrl = new URL(artifact.url);
      const transportUrl = frozenUrl.origin + frozenUrl.pathname.replace(/[+~%]/g, (character) => "%" + character.charCodeAt(0).toString(16));
      const uri = /^'([^'\r\n]+)' ([A-Za-z0-9._~+%:-]+\.deb) ([0-9]+) (?:(?:MD5Sum|MD5|SHA1|SHA256|SHA512):)?([A-Fa-f0-9]+)\s*$/.exec(resolved.stdout);
      if (resolved.status !== "completed" || resolved.exitCode !== 0 || !uri || (uri[1] !== artifact.url && uri[1] !== transportUrl) || Number(uri[3]) !== artifact.size || (resolved.stdout.includes("SHA256:") && uri[4]!.toLowerCase() !== artifact.sha256)) throw new AptPayloadUnavailable("The signed repository does not resolve the frozen artifact URL and size");
      await authorize();
      await this.unchanged(directory);
      const downloaded = await run(["apt-get", ...options, "download", target], { cwd: directory });
      await this.unchanged(directory);
      const entries = await readdir(directory);
      if (entries.length !== 1 || entries[0] !== uri[2]) throw new AptPayloadRecovery("The artifact operation produced unknown private entries");
      const path = join(directory, uri[2]!);
      await this.bind(path, false);
      if (downloaded.status !== "completed" || downloaded.exitCode !== 0 || downloaded.terminationUnconfirmed) throw new AptPayloadRecovery("The artifact acquisition has no confirmed terminal result");
      await this.verify(path, profile, name, remaining);
      await this.verifyControl(host, path, artifact, remaining);
      this.paths.push(path);
    }
  }
  private async verifyControl(host: SetupHost, path: string, artifact: ReturnType<typeof aptPackageArtifacts>[string], remaining: () => number): Promise<void> {
    if (remaining() <= 0) throw new AptPayloadUnavailable("The artifact control deadline expired");
    let metadata: HostCommandResult;
    try { metadata = await host.run(["dpkg-deb", "--field", path, "Package", "Version", "Architecture"], remaining()); }
    catch { throw new AptPayloadRecovery("The artifact control reader completion could not be observed"); }
    if (metadata.status === "timeout" || metadata.terminationUnconfirmed) throw new AptPayloadRecovery("The artifact control reader has no confirmed terminal result");
    const fields = Object.fromEntries(metadata.stdout.trim().split("\n").map((line) => { const separator = line.indexOf(": "); return [line.slice(0, separator), line.slice(separator + 2)]; }));
    if (metadata.status !== "completed" || metadata.exitCode !== 0 || metadata.terminationUnconfirmed || metadata.stdout.trim().split("\n").length !== 3 || Object.keys(fields).length !== 3 || fields.Package !== artifact.name || fields.Version !== artifact.version || fields.Architecture !== artifact.architecture) throw new AptPayloadUnavailable("The verified archive control identity does not match its frozen package tuple");
  }
  async verify(path: string, profile: AptInstallProfile, name: string, remaining: () => number): Promise<void> {
    await this.unchanged(dirname(path)); await this.unchanged(path);
    const artifact = aptPackageArtifacts(profile)[name];
    if (!artifact) throw new AptPayloadUnavailable("The package is outside its declared artifact closure");
    const digest = await this.digest(path, artifact.size, remaining);
    const identity = this.entries.get(path)!;
    if (identity.sha256 !== undefined && identity.sha256 !== digest) throw new AptPayloadRecovery("A verified private archive was modified");
    this.entries.set(path, { ...identity, sha256: digest, size: artifact.size });
    if (digest !== artifact.sha256) throw new AptPayloadUnavailable("The archive payload differs from its frozen SHA256");
    await this.unchanged(path);
  }
}
