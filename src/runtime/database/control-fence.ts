import { SQL } from "bun";
import { digest } from "./maintenance";
import { privileged } from "./privilege";

/** A second control session survives loss of the primary lease until owned target sessions are retired. */
export class ControlFence {
  readonly #sql: SQL;
  readonly #tag: string;
  readonly #targets = new Map<number, string>();
  #closed = false;
  private constructor(sql: SQL, tag: string) { this.#sql = sql; this.#tag = tag; }
  static async acquire(url: string, cluster: string, database: string, mode: "shared" | "exclusive" | "revision", nonce: string): Promise<ControlFence> {
    const sql = new SQL(url, { max: 1, connectionTimeout: 2, idleTimeout: 0, maxLifetime: 0 });
    const key = BigInt.asIntN(64, BigInt(`0x${digest(`fleur:${mode === "revision" ? "revision" : "target-fence"}:v1:${cluster}:${database}`).slice(0, 16)}`)).toString();
    const fence = new ControlFence(sql, `fleur-managed:${nonce}`);
    try {
      await sql.unsafe("SET statement_timeout='5s'");
      const actual = (await privileged("identity inspection", () => sql.unsafe("SELECT system_identifier::text AS cluster FROM pg_control_system()")))[0];
      if (actual?.cluster !== cluster) throw new Error("CONFIGURATION_MISSING");
      // Revision initialization waits as its former transaction lock did. Maintenance never waits behind an orphan.
      const rows = await privileged("maintenance locks", () => sql.unsafe(mode === "revision" ? "SELECT true AS acquired FROM (SELECT pg_advisory_lock($1::bigint)) waited" : `SELECT pg_try_advisory_lock${mode === "shared" ? "_shared" : ""}($1::bigint) AS acquired`, [key]));
      if (rows[0]?.acquired !== true) throw new Error("MAINTENANCE_BUSY");
      return fence;
    } catch (error) { await sql.close({ timeout: 0 }); throw error; }
  }
  async attach(target: Pick<SQL, "unsafe">, database: string, exclusive: boolean): Promise<void> {
    if (this.#closed) throw new Error("RECOVERY_REQUIRED");
    const rows = await target.unsafe("SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()");
    const row = rows[0];
    if (!Number.isSafeInteger(row?.pid) || typeof row.started !== "string") throw new Error("RECOVERY_REQUIRED");
    // Tag before BEGIN, then recheck primary lease authority at the caller. A process crash may drop control sockets
    // before PostgreSQL notices its application socket. Maintenance refuses those tagged sessions until they retire.
    this.#targets.set(row.pid, row.started);
    await target.unsafe("SELECT set_config('application_name',$1,false)", [this.#tag]);
    if (exclusive) {
      const other = await this.#sql.unsafe("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name LIKE 'fleur-managed:%' AND application_name<>$2 LIMIT 1", [database, this.#tag]);
      if (other.length) throw new Error("MAINTENANCE_BUSY");
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    // Verify retirement before releasing the second lock. A timer closing the lease cannot expose active target work.
    for (const [pid, started] of this.#targets) {
      const rows = await this.#sql.unsafe("SELECT pid,state,xact_start IS NOT NULL AS transaction FROM pg_stat_activity WHERE pid=$1::integer AND extract(epoch FROM backend_start)::text=$2 AND application_name=$3", [pid, started, this.#tag]);
      if (!rows.length) continue;
      if (rows.length) {
        const stopped = await this.#sql.unsafe("SELECT pg_terminate_backend(pid,1000) AS stopped FROM pg_stat_activity WHERE pid=$1::integer AND extract(epoch FROM backend_start)::text=$2 AND application_name=$3", [pid, started, this.#tag]);
        if (stopped.length && stopped[0]?.stopped !== true) throw new Error("RECOVERY_REQUIRED");
      }
    }
    this.#closed = true;
    await this.#sql.close({ timeout: 0 });
  }
}
