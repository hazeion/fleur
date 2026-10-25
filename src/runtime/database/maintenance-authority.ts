import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MaintenanceLease, digest, syncDirectory } from "./maintenance";
import { publishFile } from "./inspection";

export interface MaintenanceApproval {
  readonly action: "migration" | "restore" | "reconcile" | "reset";
  readonly target: MaintenanceLease["target"];
  readonly checksum: string;
  readonly replacesCurrentData: boolean;
  readonly backup?: string;
}
export interface MaintenanceAuthority {
  readonly grant?: string;
  /** Trusted human-input boundary. Never supplied to application handlers. */
  readonly confirm?: (request: MaintenanceApproval) => Promise<boolean>;
}
export async function privateJson(path: string): Promise<unknown> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1048576)throw new Error("RECOVERY_REQUIRED");
    const bytes=Buffer.alloc(1048577);let used=0;
    while(used<bytes.length) {const read=await file.read(bytes,used,bytes.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead;}
    if(used>1048576)throw new Error("RECOVERY_REQUIRED");
    return JSON.parse(bytes.subarray(0,used).toString("utf8"));
  } finally {await file.close();}
}
export async function authorizeMaintenance(lease: MaintenanceLease, request: MaintenanceApproval, authority: MaintenanceAuthority): Promise<string> {
  await lease.assertSession();
  let id=authority.grant;
  const checksum=digest(JSON.stringify(request));
  if(!id) {
    if(!authority.confirm||!await authority.confirm(request))throw new Error("AUTHORITY_REQUIRED");
    await lease.assertSession();
    id=crypto.randomUUID();
    await publishFile(join(lease.directory,`grant-${id}.json`),JSON.stringify({id,checksum,user:process.getuid?.(),used:false}));
  }
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))throw new Error("AUTHORITY_REQUIRED");
  const path=join(lease.directory,`grant-${id}.json`);
  try {
    z.strictObject({id:z.literal(id),checksum:z.literal(checksum),user:z.literal(process.getuid?.()),used:z.literal(false)}).parse(await privateJson(path));
  } catch {throw new Error("AUTHORITY_REQUIRED");}
  const temporary=path+`.${crypto.randomUUID()}.tmp`;
  await publishFile(temporary,JSON.stringify({id,checksum,user:process.getuid?.(),used:true}));
  await lease.assertSession();
  await rename(temporary,path);await syncDirectory(lease.directory);
  return id;
}
export async function terminalApproval(request: MaintenanceApproval, timeoutMs: number): Promise<boolean> {
  if(!process.stdin.isTTY||!process.stdout.isTTY)return false;
  const {createInterface}=await import("node:readline/promises");
  const terminal=createInterface({input:process.stdin,output:process.stderr,terminal:true});
  try {
    const warning=request.replacesCurrentData?"This replaces or removes current data.\n":"This reconciles an interrupted operation without replaying it.\n";
    const answer=await terminal.question(`${warning}Target ${request.target.database} in cluster ${request.target.cluster}\n${request.backup?`Backup ${request.backup}\n`:""}Plan ${request.checksum}\nType 'approve' to authorize this operation once: `,{signal:AbortSignal.timeout(timeoutMs)});
    return answer==="approve";
  } catch {return false;}finally {terminal.close();process.stdin.pause();}
}
