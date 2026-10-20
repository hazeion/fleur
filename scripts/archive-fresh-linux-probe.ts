import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { dirname, join, resolve } from "node:path";
const paths = ["experiments/compatibility/runtime-probe", "experiments/compatibility/rendering/package.json", "experiments/compatibility/rendering/bun.lock"];
const required = ["experiments/compatibility/runtime-probe/run.py", "experiments/compatibility/rendering/package.json", "experiments/compatibility/rendering/bun.lock"];
const report: Record<string, unknown> = { formatVersion: 1, scope: "fresh-linux-restriction-archive", ok: false };
async function readBounded(stream: ReadableStream<Uint8Array> | Readable): Promise<string> { const parts: Uint8Array[] = []; let size = 0; for await (const chunk of stream) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("Git metadata output limit"); parts.push(chunk); } return Buffer.concat(parts).toString("utf8"); }
const validation = `import hashlib,json,os,stat,sys,tarfile
with os.fdopen(3,'rb') as metadata:raw=metadata.read(2*1024*1024+1)
if len(raw)>2*1024*1024:raise RuntimeError('Expected member bound')
expected=json.loads(raw);seen=set();count=0
fd=os.dup(0)
with os.fdopen(fd,'rb') as f:
 s=os.fstat(f.fileno())
 if not stat.S_ISREG(s.st_mode) or s.st_size>16*1024*1024:raise RuntimeError('Owned tar input bound')
 f.seek(0);whole=hashlib.sha256()
 while chunk:=f.read(1024*1024):whole.update(chunk)
 f.seek(0)
 with tarfile.open(fileobj=f,mode='r:') as archive:
  for member in archive:
   count+=1;name=member.name.rstrip('/')
   if count>20000 or name.startswith('/') or '..' in name.split('/'):raise RuntimeError('Unsafe tar member')
   if member.isdir():
    if not any(p.startswith(name+'/') for p in expected):raise RuntimeError('Unrelated tar directory')
    continue
   if not member.isreg() or member.sparse or name not in expected or name in seen or member.size>16*1024*1024:raise RuntimeError('Unexpected tar file')
   stream=archive.extractfile(member)
   if stream is None:raise RuntimeError('Missing tar file body')
   body=stream.read(16*1024*1024+1)
   if len(body)!=member.size:raise RuntimeError('Tar body bound')
   oid=hashlib.sha1(b'blob '+str(len(body)).encode()+b'\\0'+body).hexdigest()
   if oid!=expected[name]:raise RuntimeError('Archive bytes differ from exact tracked blob')
   seen.add(name)
 after=os.fstat(f.fileno())
 if (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise RuntimeError('Archive changed during validation')
if seen!=set(expected):raise RuntimeError('Archive omitted tracked inputs')
print(json.dumps({'ok':True,'files':len(seen),'sha256':whole.hexdigest()}))
`;
async function validateArchive(file: FileHandle, expected: Record<string, string>): Promise<string> {
  const metadata = Buffer.from(JSON.stringify(expected));
  if (metadata.length > 2 * 1024 * 1024) throw new Error("Tracked member map exceeds its input bound");
  // Descriptor 0 retains the archive; descriptor 3 carries metadata without argv limits.
  const child = spawn("python3", ["-I", "-c", validation], { detached: true, stdio: [file.fd, "pipe", "pipe", "pipe"] });
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
  const timer = setTimeout(kill, 30000);
  const finished = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
  try {
    const submitted = new Promise<void>((resolve, reject) => { const stream = child.stdio[3] as Writable; stream.once("error", reject); stream.end(metadata, () => resolve()); });
    const [stdout, stderr, code] = await Promise.all([readBounded(child.stdout!), readBounded(child.stderr!), finished, submitted]);
    if (code !== 0) throw new Error(`Tracked archive byte verification failed: ${stderr.slice(-2048)}`);
    const observed = JSON.parse(stdout);
    if (observed.ok !== true || !/^[a-f0-9]{64}$/.test(observed.sha256)) throw new Error("Tracked archive byte verifier returned invalid evidence");
    return observed.sha256;
  } finally { clearTimeout(timer); kill(); await finished.catch(() => {}); }
}
async function retainedHash(file: FileHandle, size: number): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536);
  for (let position = 0; position < size;) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) throw new Error("Retained archive was truncated");
    hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  return hash.digest("hex");
}
async function git(repository: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", repository, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });

  try { const [stdout, stderr, code] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]); if (code !== 0) throw new Error(`Git metadata failed: ${stderr.slice(-2048)}`); return stdout; }
  finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--repository" || args[2] !== "--commit" || args[4] !== "--out" || !/^[a-f0-9]{40}$/.test(args[3]!)) throw new Error("Use --repository <source> --commit <exact-commit> --out <new-owned-archive>.");
  const repository = await realpath(args[1]!); const commit = args[3]!; const output = resolve(args[5]!); const parent = await open(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const directory = await parent.stat(); if (directory.uid !== process.getuid!() || directory.mode & 0o077) throw new Error("Archive output requires a private owned directory");
    if ((await git(repository, ["cat-file", "-t", commit])).trim() !== "commit") throw new Error("An exact commit object is required");
    const entries = (await git(repository, ["ls-tree", "-r", "-z", commit, "--", ...paths])).split("\0").filter(Boolean);
    const blobs: Record<string, string> = {};
    const members = entries.map((entry) => { const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry); if (!match) throw new Error("Archive inputs must be tracked regular files"); blobs[match[3]!] = match[2]!; return match[3]!; });
    if (members.length > 10000 || !required.every((path) => members.includes(path))) throw new Error("The exact commit lacks required restriction-probe inputs");
    const checkParent = async () => { const actual = await lstat(dirname(output)); if (!actual.isDirectory() || actual.dev !== directory.dev || actual.ino !== directory.ino) throw new Error("Owned archive parent changed"); };
    await checkParent();
    const file = await open(output, "wx+", 0o600); const identity = await file.stat(); let published = false;
    try {
      const child = Bun.spawn(["git", "-C", repository, "archive", "--format=tar", commit, "--", ...paths], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
      const hash = new Bun.CryptoHasher("sha256"); let size = 0;
      try {
        const stderr = readBounded(child.stderr);
        for await (const bytes of child.stdout) { size += bytes.length; if (size > 16 * 1024 * 1024) throw new Error("Restriction archive output limit"); hash.update(bytes); await file.writeFile(bytes); }
        const code = await child.exited; const diagnostic = await stderr; if (code !== 0 || diagnostic.length > 2 * 1024 * 1024) throw new Error("Restriction archive construction failed");
        await file.sync(); const beforeValidation = await file.stat(); const streamedSha256 = hash.digest("hex");
        await checkParent(); const validatedSha256 = await validateArchive(file, blobs); const finalSha256 = await retainedHash(file, size);
        const final = await file.stat(); const after = await lstat(output); await checkParent();
        if (after.dev !== identity.dev || after.ino !== identity.ino || !after.isFile() || after.size !== size || final.size !== size || beforeValidation.mtimeMs !== final.mtimeMs || beforeValidation.ctimeMs !== final.ctimeMs || finalSha256 !== streamedSha256 || validatedSha256 !== finalSha256) throw new Error("Retained archive bytes or public identity changed");
        report.commit = commit; report.sha256 = finalSha256; report.bytes = size; report.files = members; report.blobs = blobs; report.ok = true; published = true;
      } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    } finally {
      await file.close();
      if (!published) {
        try {
          await checkParent();
          const claim = await mkdtemp(join(dirname(output), ".fleur-archive-claim-")); const retained = join(claim, "archive");
          // Claim before inspecting. Only this helper writes inside the fresh private namespace.
          await rename(output, retained); const current = await lstat(retained);
          if (current.dev === identity.dev && current.ino === identity.ino && current.isFile()) { await unlink(retained); await rmdir(claim); }
          else report.cleanup = { state: "unconfirmed", retainedPath: retained, reason: "Foreign output was retained without deletion" };
        } catch (error) { report.cleanup = { state: "unconfirmed", reason: error instanceof Error ? error.message : "Archive cleanup could not confirm ownership" }; }
      }
    }
  } finally { await parent.close(); }
} catch (error) { report.error = { code: "RESTRICTION_ARCHIVE_FAILED", message: error instanceof Error ? error.message : "Restriction archive failed" }; process.exitCode = 4; }
process.stdout.write(JSON.stringify(report) + "\n");
