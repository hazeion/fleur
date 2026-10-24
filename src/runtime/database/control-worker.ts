import { SQL } from "bun";
import { z } from "zod";

// This trusted executable receives its database target only from its parent.
// Worker requests never carry connection strings or backend-control authority.
const stop = setTimeout(() => process.exit(1), 250);
const request = z.strictObject({ action: z.enum(["cancel", "terminate"]), pid: z.number().int().positive(), started: z.string().min(1).max(100) });
let pool: SQL | undefined;
let result: "applied" | "absent" | "failed" = "failed";
try {
  const url = process.env.FLEUR_PRIVATE_DATABASE_URL;
  if (!url) throw new Error("Missing private database configuration");
  const input = request.parse(JSON.parse(await Bun.stdin.text()));
  pool = new SQL(url, { max: 1, connectionTimeout: 1 });
  const statement = input.action === "cancel"
    ? "SELECT pg_cancel_backend(pid) AS applied FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=current_user"
    : "SELECT pg_terminate_backend(pid,200) AS applied FROM pg_stat_activity WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=current_user";
  const rows = z.array(z.strictObject({ applied: z.boolean() })).parse(await pool.unsafe(statement, [input.pid, input.started]));
  result = rows.length === 0 ? "absent" : rows.length === 1 && rows[0]?.applied === true ? "applied" : "failed";
} catch { result = "failed"; }
console.log(JSON.stringify({ result }));
try { if (pool) await pool.close({ timeout: 0 }); } catch { /* No driver details leave the trusted process. */ }
clearTimeout(stop);
