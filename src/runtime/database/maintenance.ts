import { SQL } from "bun";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export interface MaintenanceConfiguration { readonly controlUrl?: string; readonly stateRoot?: string; readonly timeoutMs?: number; }
const identitySchema = z.strictObject({ cluster: z.string().regex(/^\d+$/), database: z.string().min(1).max(63), oid: z.string().regex(/^\d+$/), owner: z.string().min(1), address: z.string(), port: z.number().int(), });
export type DatabaseIdentity = z.infer<typeof identitySchema>;
const markerSchema = z.strictObject({ formatVersion: z.literal(1), target: identitySchema, stage: z.enum(["preparing", "backup verified", "applying", "committed", "rollback verified", "recovery required"]), planChecksum: z.string().regex(/^[a-f0-9]{64}$/), backup: z.string().nullable(), verification: z.strictObject({ database: z.string(), role: z.string(), token: z.string() }).optional(), log: z.array(z.strictObject({ at: z.string(), stage: z.string(), planChecksum: z.string().regex(/^[a-f0-9]{64}$/) })).max(200).optional(), logTruncated: z.boolean().optional(), epoch: z.string().uuid(), });
export type MaintenanceMarker = z.infer<typeof markerSchema>;
export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function databaseUrl(value: string): URL {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.search || url.hash || !/^\/[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(url.pathname)) throw new Error("CONFIGURATION_MISSING");
  return url;
}
export async function privateDirectory(path: string): Promise<void> {
  let ancestor = resolve(path);
  while (true) {
    try {
      const parent = await lstat(ancestor);
      if (parent.isSymbolicLink() && parent.uid !== 0) throw new Error("RECOVERY_REQUIRED");
      if (parent.uid !== 0 && parent.uid !== process.getuid?.()) throw new Error("RECOVERY_REQUIRED");
      if ((parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0)) throw new Error("RECOVERY_REQUIRED");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = dirname(ancestor); if (next === ancestor) break; ancestor = next;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("RECOVERY_REQUIRED");
  // Flush every entry, including ancestors created by another concurrent
  // admission. Syncing only the marker directory cannot retain its own name.
  let directory = await realpath(path);
  for (;;) {
    await syncDirectory(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
export class MaintenanceLease {
  readonly sql: SQL;
  readonly target: DatabaseIdentity;
  readonly key: string;
  readonly directory: string;
  readonly #pid: number;
  readonly #nonce: string;
  readonly #exclusive: boolean;
  readonly busy: boolean;
  private constructor(sql: SQL, target: DatabaseIdentity, key: string, directory: string, pid: number, exclusive: boolean, nonce: string, busy = false) {
    this.sql = sql; this.target = target; this.key = key; this.directory = directory; this.#pid = pid; this.#nonce = nonce; this.#exclusive = exclusive; this.busy = busy;
  }
  static async acquire(urlValue: string, exclusive: boolean, configuration: MaintenanceConfiguration = {}, inspect = false): Promise<MaintenanceLease> {
    const targetUrl = databaseUrl(urlValue);
    const configuredControl = configuration.controlUrl ?? process.env.FLEUR_PRIVATE_CONTROL_DATABASE_URL;
    const controlUrl = configuredControl ? databaseUrl(configuredControl) : new URL(targetUrl);
    if (!configuredControl) controlUrl.pathname = "/postgres";
    if (controlUrl.pathname === targetUrl.pathname) throw new Error("CONFIGURATION_MISSING");
    const sql = new SQL(controlUrl.toString(), { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
    const target = new SQL(targetUrl.toString(), { max: 1, connectionTimeout: 2 });
    const timer = setTimeout(() => { void sql.close({ timeout: 0 }).catch(() => {}); void target.close({ timeout: 0 }).catch(() => {}); }, Math.min(configuration.timeoutMs ?? 5000, 5000));
    try {
      const control = await sql.unsafe("SELECT system_identifier::text AS cluster, pg_backend_pid() AS pid, current_database() AS database, coalesce(inet_server_addr()::text,'') AS address, inet_server_port() AS port FROM pg_control_system()");
      const current = control[0];
      if (!current || current.database !== controlUrl.pathname.slice(1) || !Number.isSafeInteger(current.pid)) throw new Error("CONFIGURATION_MISSING");
      const rows = inspect
        ? await sql.unsafe("SELECT $1::text AS database, coalesce(d.oid::text,'0') AS oid, coalesce(pg_get_userbyid(d.datdba),'missing') AS owner FROM (SELECT 1) one LEFT JOIN pg_database d ON d.datname=$1", [targetUrl.pathname.slice(1)])
        : await target.unsafe("SELECT system_identifier::text AS cluster, current_database() AS database, d.oid::text AS oid, pg_get_userbyid(d.datdba) AS owner, coalesce(inet_server_addr()::text,'') AS address, inet_server_port() AS port FROM pg_control_system(), pg_database d WHERE d.datname=current_database()");
      const identity = identitySchema.parse(inspect ? { ...rows[0], cluster: current.cluster, address: current.address, port: current.port } : rows[0]);
      if (identity.database !== targetUrl.pathname.slice(1) || current.cluster !== identity.cluster || current.address !== identity.address || current.port !== identity.port) throw new Error("CONFIGURATION_MISSING");
      const hash = digest(`fleur:maintenance:v1:${identity.cluster}:${identity.database}`);
      const key = BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`)).toString();
      const nonce = crypto.randomUUID();
      await sql.unsafe("BEGIN");
      await sql.unsafe("SELECT set_config('fleur.maintenance_session',$1,false)", [nonce]);
      await sql.unsafe("COMMIT");
      const lock = await sql.unsafe(`SELECT pg_try_advisory_lock${exclusive ? "" : "_shared"}($1::bigint) AS acquired, pg_backend_pid() AS pid`, [key]);
      if (lock[0]?.pid !== current.pid) throw new Error("CONFIGURATION_MISSING");
      if (lock[0]?.acquired !== true && !inspect) throw new Error("MAINTENANCE_BUSY");
      const directory = join(configuration.stateRoot ?? process.env.FLEUR_PRIVATE_STATE_ROOT ?? join(homedir(), ".local", "state", "fleur", "databases"), hash);
      await privateDirectory(directory);
      const lease = new MaintenanceLease(sql, identity, key, directory, current.pid as number, exclusive, nonce, lock[0]?.acquired !== true);
      if (!lease.busy) await lease.assertSession();
      const marker = await lease.marker();
      if (!inspect && marker && !["committed", "rollback verified"].includes(marker.stage)) throw new Error("RECOVERY_REQUIRED");
      if (!inspect && marker && (marker.target.cluster !== identity.cluster || marker.target.database !== identity.database || marker.target.owner !== identity.owner || marker.target.oid !== identity.oid)) throw new Error("RECOVERY_REQUIRED");
      return lease;
    } catch (error) {
      await sql.close({ timeout: 0 });
      if (error instanceof Error && ["CONFIGURATION_MISSING", "MAINTENANCE_BUSY", "RECOVERY_REQUIRED"].includes(error.message)) throw error;
      throw new Error("PREREQUISITE_UNAVAILABLE");
    } finally { clearTimeout(timer); await target.close({ timeout: 0 }); }
  }
  async assertSession(): Promise<void> {
    const unsigned = BigInt.asUintN(64, BigInt(this.key));
    const rows = await this.sql.unsafe("SELECT pg_backend_pid() AS pid, current_setting('fleur.maintenance_session',true) AS nonce, EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND mode=$3 AND granted) AS held", [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString(), this.#exclusive ? "ExclusiveLock" : "ShareLock"]);
    if (rows[0]?.pid !== this.#pid || rows[0]?.nonce !== this.#nonce || rows[0]?.held !== true) throw new Error("RECOVERY_REQUIRED");
  }
  async marker(): Promise<MaintenanceMarker | null> {
    let file;
    try { file = await open(join(this.directory, "maintenance.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("RECOVERY_REQUIRED"); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error("RECOVERY_REQUIRED");
      return markerSchema.parse(JSON.parse(await file.readFile("utf8")));
    } catch { throw new Error("RECOVERY_REQUIRED"); } finally { await file.close(); }
  }
  async persist(marker: MaintenanceMarker): Promise<void> {
    if (!this.#exclusive) throw new Error("REQUEST_DENIED");
    await this.assertSession();
    const previous = await this.marker();
    const log = [...previous?.log ?? [], { at: new Date().toISOString(), stage: marker.stage, planChecksum: marker.planChecksum }];
    const value = markerSchema.parse({ ...marker, log: log.slice(-200), logTruncated: previous?.logTruncated === true || log.length > 200 });
    if (JSON.stringify(value.target) !== JSON.stringify(this.target)) throw new Error("REQUEST_DENIED");
    const path = join(this.directory, `stage-${crypto.randomUUID()}.tmp`);
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)+"\n"); await file.sync(); } finally { await file.close(); }
    await rename(path, join(this.directory, "maintenance.json"));
    await syncDirectory(this.directory);
  }
  async close(): Promise<void> { await this.sql.close({ timeout: 0 }); }
}
