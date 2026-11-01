import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { queryDevelopmentDatabase } from "../../src/runtime/database/query";

let pg: Awaited<ReturnType<typeof ownedPostgres>>, admin: SQL, root: string;
const password = crypto.randomUUID();
beforeAll(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "fleur-query-test-"));
  pg = await ownedPostgres(); admin = new SQL(pg.url);
  await admin.unsafe("CREATE TABLE public.items(id bigint PRIMARY KEY, label text NOT NULL); INSERT INTO public.items VALUES(1,'kept')");
}, 60000);
afterAll(async () => { await admin?.close(); await pg?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
const query = (sql: string, params: readonly string[] = [], limit = 100, timeoutMs = 5000) => queryDevelopmentDatabase(pg.url, password, root, { sql, params, limit, timeoutMs }, { stateRoot: root });

test("agent diagnostics retain duplicate names, PostgreSQL types and exact bound text without modifying data", async () => {
  const injection = "'); DELETE FROM items; --";
  const result = await query("SELECT $1::text AS same, 9007199254740993::bigint AS same, 1.2300::numeric(8,4) AS amount, NULL::text AS absent", [injection]);
  expect(result.columns).toEqual([{ name: "same", type: "text" }, { name: "same", type: "bigint" }, { name: "amount", type: "numeric(8,4)" }, { name: "absent", type: "text" }]);
  expect(result.rows).toEqual([[injection, "9007199254740993", "1.2300", null]]);
  expect(result.truncated).toBe(false);
  expect((await admin.unsafe("SELECT label FROM items"))[0].label).toBe("kept");
}, 30000);

test("writes, utility commands, writable CTEs, sequence effects and private metadata are rejected without changes", async () => {
  await admin.unsafe("CREATE SEQUENCE public.query_sequence; CREATE SCHEMA IF NOT EXISTS fleur_internal; CREATE TABLE fleur_internal.query_secret(value text)");
  const statements = [
    "INSERT INTO items VALUES(2,'lost')", "UPDATE items SET label='lost'", "DELETE FROM items", "CREATE TABLE public.lost(id int)",
    "WITH changed AS (DELETE FROM items RETURNING *) SELECT * FROM changed", "SELECT 1; DELETE FROM items", "SELECT 1) AS escaped; DELETE FROM items; SELECT (1",
    "SET statement_timeout=0", "SET TRANSACTION READ WRITE", "SELECT * FROM items FOR UPDATE", "SELECT nextval('public.query_sequence')", "CREATE TEMP TABLE lost(id int)", "SELECT * FROM fleur_internal.query_secret",
    "SELECT set_config('temp_file_limit','-1',false)",
  ];
  for (const statement of statements) {
    try { await query(statement); throw new Error(`Unexpected success: ${statement}`); }
    catch (error) { expect(error).toBeInstanceOf((await import("../../src/runtime/database/query")).QueryRejected); }
  }
  expect(await admin.unsafe("SELECT id::text,label FROM items")).toEqual([{ id: "1", label: "kept" }]);
  expect((await admin.unsafe("SELECT last_value::text,is_called FROM query_sequence"))[0]).toEqual({ last_value: "1", is_called: false });
  expect((await admin.unsafe("SELECT to_regclass('public.lost') AS table"))[0].table).toBeNull();
}, 30000);

test("diagnostics truncate at row and byte bounds, expose empty result columns and refuse RLS", async () => {
  expect(await query("VALUES (1),(2),(3)", [], 2)).toMatchObject({ rows: [["1"], ["2"]], truncated: true });
  expect(await query("SELECT 1::integer AS empty WHERE false")).toMatchObject({ columns: [{ name: "empty", type: "integer" }], rows: [], truncated: false });
  const large = await query("SELECT repeat('x',600000) AS value FROM generate_series(1,3)");
  expect(large.rows).toHaveLength(1); expect(large.truncated).toBe(true);
  const huge = await query("SELECT repeat('x',2000000) AS value");
  expect(huge.rows).toEqual([]); expect(huge.truncated).toBe(true);
  await admin.unsafe("ALTER TABLE items ENABLE ROW LEVEL SECURITY");
  try { await expect(query("TABLE items")).rejects.toMatchObject({ diagnostic: { sqlstate: "42501" } }); }
  finally { await admin.unsafe("ALTER TABLE items DISABLE ROW LEVEL SECURITY"); }
}, 30000);

test("a host deadline terminates the agent backend even if SQL disables its statement timeout", async () => {
  const started = performance.now();
  await expect(query("SELECT set_config('statement_timeout','0',true), pg_sleep(10)", [], 100, 700)).rejects.toThrow("QUERY_TIMEOUT");
  expect(performance.now() - started).toBeLessThan(3000);
  expect((await admin.unsafe("SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename='fleur_agent_query_v1'"))[0].count).toBe("0");
  expect((await query("VALUES ('after timeout')")).rows).toEqual([["after timeout"]]);
}, 10000);

test("agent authority cannot connect to control or temporary targets and repairs grants before another request", async () => {
  await query("SELECT 1");
  const role = "fleur_agent_query_v1", login = new URL(pg.url); login.username = role; login.password = password;
  login.pathname = "/postgres";
  const control = new SQL(login.toString(), { max: 1, connectionTimeout: 1 });
  try { await expect(control.connect()).rejects.toMatchObject({ errno: "42501" }); } finally { await control.close(); }
  await admin.unsafe(`REVOKE SELECT ON items FROM ${role}`);
  expect((await query("TABLE items")).rows).toEqual([["1", "kept"]]);
  const attributes = (await admin.unsafe("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit,rolconnlimit FROM pg_roles WHERE rolname=$1", [role]))[0];
  expect(attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false, rolconnlimit: 4 });
}, 10000);

test("PUBLIC function authority cannot turn agent SQL into a privileged file read", async () => {
  await admin.unsafe("CREATE FUNCTION public.read_private() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$SELECT pg_read_file('/etc/passwd')$$");
  try { await expect(query("SELECT public.read_private()")).rejects.toThrow("DATABASE_PRIVILEGE_INSUFFICIENT"); }
  finally { await admin.unsafe("DROP FUNCTION public.read_private()"); }
}, 10000);

test("active maintenance and recovery both refuse query before changing privileges", async () => {
  const { MaintenanceLease, digest } = await import("../../src/runtime/database/maintenance");
  const lease = await MaintenanceLease.acquire(pg.url, true, { stateRoot: root }, true);
  try {
    await expect(query("SELECT 1")).rejects.toThrow("MAINTENANCE_BUSY");
    await lease.persist({ formatVersion: 1, target: lease.target, stage: "recovery required", planChecksum: digest("query-test"), backup: null, epoch: crypto.randomUUID() });
  } finally { await lease.close(); }
  try { await expect(query("SELECT 1")).rejects.toThrow("MAINTENANCE_BUSY"); }
  finally {
    const repair = await MaintenanceLease.acquire(pg.url, true, { stateRoot: root }, true);
    try { await repair.persist({ ...(await repair.marker())!, stage: "committed" }); } finally { await repair.close(); }
  }
}, 10000);

test("legal pg-prefixed schemas and owner-rights views cannot expose internal data", async () => {
  await admin.unsafe("INSERT INTO fleur_internal.query_secret VALUES('private sentinel'); CREATE SCHEMA pgprivate; GRANT USAGE ON SCHEMA pgprivate TO PUBLIC; CREATE FUNCTION pgprivate.read_private() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$SELECT value FROM fleur_internal.query_secret LIMIT 1$$");
  try { await expect(query("SELECT pgprivate.read_private()")).rejects.toThrow("DATABASE_PRIVILEGE_INSUFFICIENT"); }
  finally { await admin.unsafe("DROP SCHEMA pgprivate CASCADE"); }
  await admin.unsafe("CREATE VIEW public.private_view AS SELECT * FROM fleur_internal.query_secret");
  try { await expect(query("TABLE public.private_view")).rejects.toMatchObject({ diagnostic: { sqlstate: "42501" } }); }
  finally { await admin.unsafe("DROP VIEW public.private_view"); }
}, 10000);

test("automatic identity details remain private even when selected by SQL", async () => {
  const result = await query("SELECT current_user,inet_server_addr()::text,inet_server_port()::text");
  expect(result.rows).toEqual([["[redacted]", "[redacted]", "[redacted]"]]);
});

test("application advisory locks give the diagnostic role no authority over Fleur's control fences", async () => {
  await query("SELECT 1");
  const { MaintenanceLease } = await import("../../src/runtime/database/maintenance");
  const lease = await MaintenanceLease.acquire(pg.url, true, { stateRoot: root }, true);
  const login = new URL(pg.url); login.username = "fleur_agent_query_v1"; login.password = password;
  const diagnostic = new SQL(login.toString(), { max: 1 });
  try {
    await diagnostic.unsafe("SELECT pg_advisory_lock($1::bigint)", [lease.key]);
    await lease.fence("exclusive", admin);
    await lease.assertSession();
  } finally { await diagnostic.close(); await lease.close(); }
});
