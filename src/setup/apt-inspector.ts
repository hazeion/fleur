/** Fixed, self-contained privileged read-only program. Only Node built-ins are imported. */
export const aptInspectorProgram = String.raw`
const fs = await import("node:fs/promises");
const { constants } = await import("node:fs");
let deadlineNs; let stage="invocation";
const assert = (value) => { if (deadlineNs !== undefined && process.hrtime.bigint() >= deadlineNs) throw new Error("Inspection deadline expired"); if (!value) throw new Error("Retained APT inspection refused"); };
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const fields = (info) => ({ dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 4095n), nlink: String(info.nlink), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const handles = [];
try {
 assert(process.platform === "linux" && process.getuid() === 0 && process.argv.length === 2);
 const raw = process.argv[1]; assert(raw.length <= 16384);
 const request = JSON.parse(raw);
 assert(Object.keys(request).sort().join(",") === "accountSha256,deadlineNs,directories,executableSha256,formatVersion,parentPid,parentStart,user");
 assert(typeof request.deadlineNs === "string" && /^[0-9]{1,20}$/.test(request.deadlineNs)); deadlineNs=BigInt(request.deadlineNs);
 assert(request.formatVersion === 1 && integer(request.parentPid) && request.parentPid > 1 && integer(request.user) && request.user > 0 && /^[0-9]+$/.test(request.parentStart) && /^[a-f0-9]{64}$/.test(request.executableSha256));
 assert(Array.isArray(request.directories) && request.directories.length === 5);
 const paths = [".","archives","local-lists","archives/partial","local-lists/auxfiles"];
 const parent = async () => {
  const root = "/proc/" + request.parentPid;
  assert((await fs.stat(root)).uid === request.user);
  const info = await fs.open(root + "/stat", constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
   const bytes = Buffer.alloc(65537); const read = await info.read(bytes,0,bytes.length,0); assert(read.bytesRead < bytes.length);
   const text = bytes.subarray(0,read.bytesRead).toString();
   assert(text.slice(0,text.indexOf(" ")) === String(request.parentPid));
   assert(text.slice(text.lastIndexOf(") ")+2).split(/\s+/)[19] === request.parentStart);
  } finally { await info.close(); }
 };
 const digest = async (path) => {
  const file = await fs.open(path, constants.O_RDONLY); handles.push(file);
  const before = await file.stat({bigint:true}); assert(before.isFile() && before.size > 0n && before.size <= 268435456n);
  const hash = new Bun.CryptoHasher("sha256"); const buffer = Buffer.alloc(65536); let used = 0;
  while (used <= Number(before.size)) { assert(true); const {bytesRead} = await file.read(buffer,0,Math.min(buffer.length,Number(before.size)+1-used),used); if (!bytesRead) break; used += bytesRead; hash.update(buffer.subarray(0,bytesRead)); }
  assert(used === Number(before.size) && same(fields(before),fields(await file.stat({bigint:true}))));
  return hash.digest("hex");
 };
 await parent(); stage="executable";
 assert(await digest("/proc/self/exe") === request.executableSha256 && await digest("/proc/"+request.parentPid+"/exe") === request.executableSha256);
 stage="directories";
 const opened = [];
 for (let i=0;i<paths.length;i++) {
  const item=request.directories[i]; assert(Object.keys(item).sort().join(",") === "fd,metadata,path" && item.path === paths[i] && integer(item.fd));
  assert(Object.keys(item.metadata).sort().join(",") === "ctimeNs,dev,gid,ino,mode,mtimeNs,nlink,uid");
  const ref="/proc/"+request.parentPid+"/fd/"+item.fd;
  // Intentionally follow only this bound parent FD, never caller-selected paths.
  const held=await fs.open(ref, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK); handles.push(held);
  const info=await held.stat({bigint:true}); assert(info.isDirectory() && same(fields(info),item.metadata));
  if (i<3) assert(info.uid === BigInt(request.user) && Number(info.mode & 4095n) === (i===2?493:448));
  opened.push(held);
  if(i>0) {
   const owner=i===1||i===2?opened[0]:i===3?opened[1]:opened[2];
   const name=i===1?"archives":i===2?"local-lists":i===3?"partial":"auxfiles";
   const relative=await fs.open("/proc/self/fd/"+owner.fd+"/"+name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(relative);
   assert(same(fields(await relative.stat({bigint:true})),item.metadata));
  }
 }
 // Ordinary-user owner lookup is not accepted as proof. Read the protected local
 // account database here and bind its exact digest to the result.
 stage="account";
 const passwd=await fs.open("/etc/passwd",constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);handles.push(passwd);
 const accountInfo=await passwd.stat({bigint:true});assert(accountInfo.isFile()&&accountInfo.uid===0n&&(accountInfo.mode&18n)===0n&&accountInfo.nlink===1n&&accountInfo.size>0n&&accountInfo.size<=1048576n);
 const accountBytes=Buffer.alloc(Number(accountInfo.size)+1);let count=0;
 while(count<accountBytes.length){assert(true);const read=await passwd.read(accountBytes,count,accountBytes.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
 assert(BigInt(count)===accountInfo.size&&same(fields(accountInfo),fields(await passwd.stat({bigint:true}))));
 assert(Bun.CryptoHasher.hash("sha256",accountBytes.subarray(0,count),"hex")===request.accountSha256);
 const rows=accountBytes.subarray(0,count).toString().split("\n").filter(Boolean).map(line=>line.split(":"));
 const apt=rows.filter(row=>row[0]==="_apt");assert(apt.length===1&&apt[0].length===7&&/^[1-9][0-9]*$/.test(apt[0][2]));
 const aptUid=Number(apt[0][2]);assert(integer(aptUid)&&aptUid!==request.user&&rows.filter(row=>Number(row[2])===aptUid).length===1);
 stage="contents";
 for(let i=3;i<5;i++) {
  const metadata=request.directories[i].metadata;
  assert((metadata.uid===0||metadata.uid===aptUid||metadata.uid===request.user)&&metadata.mode===(i===3?448:493));
  // Bounded enumeration: a single unknown child refuses, without traversal or
  // reading any child contents. The open descriptor pins the directory inode.
  const directory=await fs.opendir("/proc/self/fd/"+opened[i].fd,{bufferSize:1});
  try{assert(await directory.read()===null);}finally{await directory.close();}
 }
 stage="final-custody";
 await parent();
 for(let i=0;i<5;i++)assert(same(fields(await opened[i].stat({bigint:true})),request.directories[i].metadata));
 assert(same(fields(accountInfo),fields(await fs.lstat("/etc/passwd",{bigint:true}))));
 process.stdout.write(JSON.stringify({formatVersion:1,empty:true,requestSha256:Bun.CryptoHasher.hash("sha256",raw,"hex"),accountSha256:Bun.CryptoHasher.hash("sha256",accountBytes.subarray(0,count),"hex"),aptUid,directories:request.directories.map(({path,metadata})=>({path,metadata}))})+"\n");
} catch { process.stderr.write(JSON.stringify({code:"APT_INSPECTION_REFUSED",stage})+"\n"); process.exitCode=5; }
finally { for(const handle of handles.reverse())await handle.close(); }
`;
