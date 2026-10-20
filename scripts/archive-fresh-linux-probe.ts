import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const paths = ["experiments/compatibility/runtime-probe", "experiments/compatibility/rendering/package.json", "experiments/compatibility/rendering/bun.lock"];
const required = ["experiments/compatibility/runtime-probe/run.py", "experiments/compatibility/rendering/package.json", "experiments/compatibility/rendering/bun.lock"];
const report: Record<string, unknown> = { formatVersion: 1, scope: "fresh-linux-restriction-archive", ok: false };
async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> { const parts: Uint8Array[] = []; let size = 0; for await (const chunk of stream) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("Git metadata output limit"); parts.push(chunk); } return Buffer.concat(parts).toString("utf8"); }
const validation = `import hashlib,json,os,stat,sys,tarfile
raw=sys.stdin.buffer.read(2*1024*1024+1)
if len(raw)>2*1024*1024:raise RuntimeError('Expected member bound')
expected=json.loads(raw);seen=set();count=0
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb') as f:
 s=os.fstat(f.fileno())
 if not stat.S_ISREG(s.st_mode) or s.st_size>16*1024*1024:raise RuntimeError('Owned tar input bound')
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
if seen!=set(expected):raise RuntimeError('Archive omitted tracked inputs')
print(json.dumps({'ok':True,'files':len(seen)}))
`;
async function validateArchive(output: string, expected: Record<string, string>): Promise<void> {
  const child = Bun.spawn(["python3", "-I", "-c", validation, output], { stdin: new TextEncoder().encode(JSON.stringify(expected)), stdout: "pipe", stderr: "pipe", timeout: 30000 });
  try {
    const [stdout, stderr, code] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]);
    if (code !== 0 || JSON.parse(stdout).ok !== true) throw new Error(`Tracked archive byte verification failed: ${stderr.slice(-2048)}`);
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
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
    const file = await open(output, "wx", 0o600); const identity = await file.stat(); let published = false;
    try {
      const child = Bun.spawn(["git", "-C", repository, "archive", "--format=tar", commit, "--", ...paths], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
      const hash = new Bun.CryptoHasher("sha256"); let size = 0;
      try {
        const stderr = readBounded(child.stderr);
        for await (const bytes of child.stdout) { size += bytes.length; if (size > 16 * 1024 * 1024) throw new Error("Restriction archive output limit"); hash.update(bytes); await file.writeFile(bytes); }
        const code = await child.exited; const diagnostic = await stderr; if (code !== 0 || diagnostic.length > 2 * 1024 * 1024) throw new Error("Restriction archive construction failed");
        await file.sync(); await validateArchive(output, blobs); const after = await lstat(output); if (after.dev !== identity.dev || after.ino !== identity.ino || !after.isFile() || after.size !== size) throw new Error("Owned archive output changed");
        report.commit = commit; report.sha256 = hash.digest("hex"); report.bytes = size; report.files = members; report.blobs = blobs; report.ok = true; published = true;
      } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    } finally {
      await file.close();
      if (!published) { const current = await lstat(output); if (current.dev === identity.dev && current.ino === identity.ino && current.isFile()) await unlink(output); }
    }
  } finally { await parent.close(); }
} catch (error) { report.error = { code: "RESTRICTION_ARCHIVE_FAILED", message: error instanceof Error ? error.message : "Restriction archive failed" }; process.exitCode = 4; }
process.stdout.write(JSON.stringify(report) + "\n");
