import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AptInstallProfile, AptPackageName } from "./native.ts";
import type { HostCommandContext, HostCommandResult, SetupHost } from "./commands.ts";

export class AptPayloadUnavailable extends Error {}
export class AptPayloadRecovery extends Error {}
interface Identity { readonly dev: bigint; readonly ino: bigint; readonly directory: boolean; readonly sha256?: string; readonly size?: number }
/** Exact owned temporary entries; unknown or replaced content is retained, never recursively deleted. */
export class AptPayloadStage {
  readonly paths: string[] = [];
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
  private async digest(path: string, size: number, remaining: () => number): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat({ bigint: true });
      const identity = this.entries.get(path)!;
      if (!info.isFile() || info.uid !== BigInt(process.getuid!()) || info.nlink !== 1n || info.size !== BigInt(size) || info.dev !== identity.dev || info.ino !== identity.ino) throw new AptPayloadRecovery("Archive descriptor identity or size changed");
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
  async cleanup(): Promise<boolean> {
    try {
      for (const [path, identity] of this.entries) {
        await this.unchanged(path);
        if (identity.directory) { for (const name of await readdir(path)) if (!this.entries.has(join(path, name))) return false; }
        else if (identity.sha256 === undefined || identity.size === undefined || await this.digest(path, identity.size, () => 1) !== identity.sha256) return false;
      }
      for (const [path, identity] of [...this.entries].reverse()) {
        await this.unchanged(path);
        if (identity.directory) await rmdir(path); else await unlink(path);
      }
      return true;
    } catch { return false; }
  }
  async acquire(host: SetupHost, profile: AptInstallProfile, missing: readonly string[], options: readonly string[], remaining: () => number, authorize: () => Promise<void>): Promise<void> {
    const run = (args: readonly string[], context?: HostCommandContext) => remaining() > 0 ? host.run(args, remaining(), context) : Promise.resolve<HostCommandResult>({ status: "timeout", stdout: "", stderr: "" });
    for (const name of missing as readonly AptPackageName[]) {
      const artifact = profile.artifacts[name];
      await this.unchanged(this.root);
      const directory = join(this.root, name);
      await mkdir(directory, { mode: 0o700 });
      await this.bind(directory, true);
      const target = `${name}=${profile.packages[name]}`;
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
      const metadata = await run(["dpkg-deb", "--field", path, "Package", "Version", "Architecture"]);
      const fields = Object.fromEntries(metadata.stdout.trim().split("\n").map((line) => { const separator = line.indexOf(": "); return [line.slice(0, separator), line.slice(separator + 2)]; }));
      if (metadata.status !== "completed" || metadata.exitCode !== 0 || metadata.stdout.trim().split("\n").length !== 3 || Object.keys(fields).length !== 3 || fields.Package !== name || fields.Version !== artifact.version || fields.Architecture !== artifact.architecture) throw new AptPayloadUnavailable("The verified archive control identity does not match its frozen package tuple");
      this.paths.push(path);
    }
  }
  async verify(path: string, profile: AptInstallProfile, name: AptPackageName, remaining: () => number): Promise<void> {
    await this.unchanged(dirname(path)); await this.unchanged(path);
    const artifact = profile.artifacts[name];
    const digest = await this.digest(path, artifact.size, remaining);
    const identity = this.entries.get(path)!;
    if (identity.sha256 !== undefined && identity.sha256 !== digest) throw new AptPayloadRecovery("A verified private archive was modified");
    this.entries.set(path, { ...identity, sha256: digest, size: artifact.size });
    if (digest !== artifact.sha256) throw new AptPayloadUnavailable("The archive payload differs from its frozen SHA256");
    await this.unchanged(path);
  }
}
