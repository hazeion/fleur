import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { column, defineSeed, defineTable } from "../../src/database";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations } from "../../src/runtime/database/migrations";
import { catalogFingerprint } from "../../src/runtime/database/migration-state";
import { dataIntegrity } from "../../src/runtime/database/integrity";
import { seedDatabase } from "../../src/runtime/database/seeds";

// Requirements: docs/planning/V1-SPEC.md "Inspection authority" (#73). A credential limited to the documented
// minimum-privilege profile runs the read-only operations; commands needing more authority, or a credential missing
// part of the profile, fail with DATABASE_PRIVILEGE_INSUFFICIENT (exit 4) before changing anything.
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Outcome { exit: number; stdout: string; result: { ok: boolean; truncated: boolean; data: Record<string, Json> | null; error: { code: string; message: string; expected?: { capability: string; privileges: string }; actions: { command: string; description: string }[] } | null } }

let fixture: Awaited<ReturnType<typeof ownedPostgres>>;
let root: string, tools: string;
/** Superuser connections to the application and control databases: trusted fixture setup and observation only. */
let admin: SQL, control: SQL;
let superuserUrl: string, profileUrl: string;
const role = `fleur_profile_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const password = randomUUID();
const exercises = defineTable("exercises", { columns: { id: column.uuid().generated().primaryKey(), name: column.string().max(100) } });
const entries = defineTable("entries", { versioned: false, columns: { id: column.safeInteger().generated().primaryKey(), exerciseId: column.uuid().references(exercises.id, { onDelete: "cascade" }), sets: column.safeInteger().default(3) } });

async function cli(args: string[], env: Record<string, string>): Promise<Outcome> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("FLEUR_PRIVATE_")) inherited[key] = value;
  const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), ...args, "--project", root, "--json"], { env: { ...inherited, FLEUR_PRIVATE_STATE_ROOT: root, FLEUR_PRIVATE_PG_TOOLS: tools, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  return { exit, stdout, result: JSON.parse(stdout) };
}
const profile = (env: Record<string, string> = {}) => ({ FLEUR_PRIVATE_DATABASE_URL: profileUrl, ...env });
/** No output names the role, its password, the host, the port or a URL. */
function expectNoEndpoint(outcome: Outcome) {
  const url = new URL(profileUrl);
  for (const secret of [profileUrl, superuserUrl, role, password, decodeURIComponent(new URL(superuserUrl).username), "127.0.0.1", "postgres://", "postgresql://"]) expect(outcome.stdout).not.toContain(secret);
  const values: unknown[] = [];
  const walk = (value: unknown) => { if (value && typeof value === "object") Object.values(value).forEach(walk); else values.push(value); };
  walk(outcome.result);
  expect(values).not.toContain(Number(url.port));
  expect(values).not.toContain(url.port);
}
function expectShortfall(outcome: Outcome, capability: string) {
  expect({ exit: outcome.exit, ok: outcome.result.ok, code: outcome.result.error?.code, capability: outcome.result.error?.expected?.capability, data: outcome.result.data }).toEqual({ exit: 4, ok: false, code: "DATABASE_PRIVILEGE_INSUFFICIENT", capability, data: null });
  expect(outcome.result.error!.message).toContain(capability);
  expect(outcome.result.error!.actions).toHaveLength(1);
  expect(outcome.result.error!.actions[0]!.command).toStartWith("fleur ");
  expect(outcome.result.error!.actions[0]!.description).toContain("docs/maintenance.md");
  expect(outcome.result.error!.actions[0]!.description).toContain("Credential authority");
  expectNoEndpoint(outcome);
}
/** Everything a write could touch: schema, complete data, cluster roles and databases, and Fleur's private state files. */
async function observed() {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  };
  await walk(root);
  return {
    catalog: await catalogFingerprint(admin),
    data: await dataIntegrity(admin),
    roles: (await control.unsafe("SELECT rolname FROM pg_roles ORDER BY rolname")).map((row: { rolname: string }) => row.rolname),
    databases: (await control.unsafe("SELECT datname FROM pg_database ORDER BY datname")).map((row: { datname: string }) => row.datname),
    files,
  };
}
async function stateMarkers(): Promise<{ stage: string }[]> {
  const markers: { stage: string }[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const marker = await readFile(join(root, entry.name, "maintenance.json"), "utf8").catch(() => null);
    if (marker) markers.push(JSON.parse(marker));
  }
  return markers;
}

beforeAll(async () => {
  fixture = await ownedPostgres();
  root = await mkdtemp(join(tmpdir(), "fleur-privilege-"));
  await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
  tools = await fixture.pgTools(join(root, "tools"));
  await fixture.sql.unsafe("CREATE DATABASE privilege_app");
  const url = new URL(fixture.url);
  url.pathname = "/privilege_app";
  superuserUrl = url.toString();
  admin = new SQL(superuserUrl, { max: 1, connectionTimeout: 2 });
  const controlUrl = new URL(fixture.url);
  controlUrl.pathname = "/postgres";
  control = new SQL(controlUrl.toString(), { max: 1, connectionTimeout: 2 });
  // The superuser owns and migrates the application, as an operator's maintenance credential would.
  await generateMigration(root, [exercises, entries]);
  expect((await applyMigrations(superuserUrl, root, { stateRoot: root, toolDirectory: tools })).applied).toEqual(["0001"]);
  await admin.unsafe("INSERT INTO exercises(name) VALUES ('Squat'),('Press')");
  await admin.unsafe("INSERT INTO entries(\"exerciseId\") SELECT id FROM exercises");
  // A login role holding exactly the documented profile. PUBLIC's default CONNECT, TEMPORARY, public-schema USAGE
  // and function EXECUTE grants for the profile's privileges are revoked, so only the explicit grants below remain.
  await control.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  for (const database of ["privilege_app", "postgres"]) {
    await control.unsafe(`REVOKE CONNECT, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await control.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  }
  for (const connection of [admin, control]) {
    await connection.unsafe("REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM PUBLIC");
    await connection.unsafe(`GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${role}`);
  }
  await control.unsafe(`DO $$ DECLARE f regprocedure; BEGIN FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_' LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${role}', f); END LOOP; END $$`);
  await admin.unsafe("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
  await admin.unsafe(`GRANT USAGE ON SCHEMA public, fleur_internal TO ${role}`);
  await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public, fleur_internal TO ${role}`);
  const login = new URL(superuserUrl);
  login.username = role;
  login.password = password;
  profileUrl = login.toString();
  const attributes = await control.unsafe("SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=$1", [role]);
  expect(attributes).toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false }]);
}, 300_000);
afterAll(async () => {
  await admin?.close({ timeout: 0 });
  await control?.close({ timeout: 0 });
  await fixture?.cleanup();
  await rm(root, { recursive: true, force: true });
});

test("the schema overview, db inspect --table, db migration status and status health succeed under the minimum-privilege profile", async () => {
  // PostgreSQL itself denies the profile any write, so success below cannot rest on hidden authority.
  const probe = new SQL(profileUrl, { max: 1, connectionTimeout: 2 });
  try {
    // Bun SQL queries run only when awaited, so each one is awaited here rather than handed to expect().
    const refusal = async (statement: string) => { try { await probe.unsafe(statement); return "accepted"; } catch (error) { return (error as { errno?: unknown }).errno; } };
    expect(await refusal("INSERT INTO exercises(name) VALUES ('Denied')")).toBe("42501");
    expect(await refusal("CREATE TABLE denied(id int)")).toBe("42501");
  } finally { await probe.close({ timeout: 0 }); }
  const summary = { compatible: true, applied: ["0001"], pending: [], drift: false, differenceCount: 0, maintenance: { state: "idle", stage: "committed" } };
  const overview = await cli(["db", "inspect"], profile());
  expect(overview.result.error).toBeNull();
  expect(overview.exit).toBe(0);
  expect(overview.result.data!.migrations).toEqual(summary);
  expect((overview.result.data!.tables as { name: string }[]).map(table => table.name)).toEqual(["entries", "exercises"]);
  // The profile sees the same overview as the owning credential.
  const owned = await cli(["db", "inspect"], { FLEUR_PRIVATE_DATABASE_URL: superuserUrl });
  expect(overview.result.data).toEqual(owned.result.data);
  const table = await cli(["db", "inspect", "--table", "exercises"], profile());
  expect(table.result.error).toBeNull();
  expect(table.exit).toBe(0);
  expect((table.result.data!.rows as { name: string }[]).map(row => row.name).sort()).toEqual(["Press", "Squat"]);
  const migration = await cli(["db", "migration", "status"], profile());
  expect(migration.result.error).toBeNull();
  expect(migration.exit).toBe(0);
  expect(migration.result.data!.migrations).toEqual(summary);
  const status = await cli(["status"], profile());
  expect(status.result.error).toBeNull();
  expect(status.exit).toBe(0);
  expect(status.result.data).toMatchObject({ reasons: [], database: { connectivity: "connected", target: { kind: "development", database: "privilege_app" }, migrations: summary } });
  for (const outcome of [overview, table, migration, status]) expectNoEndpoint(outcome);
}, 300_000);

test("db backup, db migration apply, db seed, db restore and db reset under the profile return DATABASE_PRIVILEGE_INSUFFICIENT, change nothing and leave no maintenance stage", async () => {
  // A pending reviewed migration that apply would otherwise back up and apply.
  await generateMigration(root, [exercises, entries, defineTable("notes", { columns: { id: column.uuid().generated().primaryKey() } })]);
  const stateDirectory = (await readdir(root)).find(name => /^[a-f0-9]{64}$/.test(name))!;
  const retained = (await readdir(join(root, stateDirectory))).find(name => /^before-.*\.dump$/.test(name))!;
  expect(retained).toBeDefined();
  const before = await observed();
  expect((await stateMarkers()).map(marker => marker.stage)).toEqual(["committed"]);
  const out = join(root, "profile-backup.dump");
  const backup = await cli(["db", "backup", "--out", out], profile());
  expectShortfall(backup, "role and database creation");
  const apply = await cli(["db", "migration", "apply"], profile());
  expectShortfall(apply, "role and database creation");
  const restore = await cli(["db", "restore", "--from", join(root, stateDirectory, retained)], profile());
  expectShortfall(restore, "role and database creation");
  const reset = await cli(["db", "reset"], profile({ FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: profileUrl }));
  expectShortfall(reset, "role and database creation");
  // CREATEROLE and CREATEDB alone cannot own the disposable verification database on PostgreSQL 16+ without the
  // set and inherit self-grant, so the preflight refuses before backup verification would fail midway.
  const maker = `${role}_maker`;
  await control.unsafe(`CREATE ROLE ${maker} LOGIN PASSWORD '${password}' CREATEROLE CREATEDB IN ROLE ${role}`);
  try {
    const login = new URL(profileUrl);
    login.username = maker;
    const creator = await cli(["db", "backup", "--out", out], { FLEUR_PRIVATE_DATABASE_URL: login.toString() });
    expectShortfall(creator, "role and database creation");
    expect(creator.stdout).not.toContain(maker);
  } finally { await control.unsafe(`DROP ROLE ${maker}`); }
  await expect(seedDatabase(profileUrl, root, [defineSeed({ key: "catalog", table: exercises, rows: [{ ownerKey: "row", values: { name: "Row" } }] })], { stateRoot: root })).rejects.toMatchObject({ message: "DATABASE_PRIVILEGE_INSUFFICIENT", capability: "schema write" });
  expect(await observed()).toEqual(before);
  expect(await Bun.file(out).exists()).toBe(false);
  expect((await stateMarkers()).map(marker => marker.stage)).toEqual(["committed"]);
  // The migration is still pending, and the profile can still read the unchanged database.
  const status = await cli(["db", "migration", "status"], profile());
  expect(status.exit).toBe(0);
  expect(status.result.data!.migrations).toMatchObject({ applied: ["0001"], pending: ["0002"], drift: false, maintenance: { state: "idle", stage: "committed" } });
  await rm(join(root, "migrations", "0002.json"));
}, 300_000);

test("db seed through the CLI under the profile returns DATABASE_PRIVILEGE_INSUFFICIENT naming schema write and changes nothing", async () => {
  const before = await observed();
  const seed = await cli(["db", "seed"], profile());
  expectShortfall(seed, "schema write");
  expect(await observed()).toEqual(before);
  expect((await stateMarkers()).map(marker => marker.stage)).toEqual(["committed"]);
}, 300_000);

test("db recover --inspect under the profile reports DATABASE_PRIVILEGE_INSUFFICIENT instead of an uncertain classification", async () => {
  // The profile cannot read identity sequences, which the recovery classification digests.
  const owned = await cli(["db", "recover", "--inspect"], { FLEUR_PRIVATE_DATABASE_URL: superuserUrl });
  expect(owned.exit).toBe(0);
  expect(owned.result.data!.actual).not.toBeNull();
  const before = await observed();
  const inspect = await cli(["db", "recover", "--inspect"], profile());
  expectShortfall(inspect, "schema read");
  expect(await observed()).toEqual(before);
}, 300_000);

test("a refused advisory lock in the application database returns DATABASE_PRIVILEGE_INSUFFICIENT naming maintenance locks", async () => {
  // With PostgreSQL's default advisory lock grants in the application database, apply with nothing pending succeeds.
  const idle = await cli(["db", "migration", "apply"], profile());
  expect(idle.result.error).toBeNull();
  expect(idle.exit).toBe(0);
  expect(idle.result.data).toMatchObject({ applied: [] });
  const functions = "SELECT p.oid::regprocedure AS f FROM pg_proc p WHERE p.pronamespace='pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_'";
  await admin.unsafe(`DO $$ DECLARE f regprocedure; BEGIN FOR f IN ${functions} LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f); END LOOP; END $$`);
  try {
    const before = await observed();
    const apply = await cli(["db", "migration", "apply"], profile());
    expectShortfall(apply, "maintenance locks");
    expect(await observed()).toEqual(before);
    expect((await stateMarkers()).map(marker => marker.stage)).toEqual(["committed"]);
  } finally {
    await admin.unsafe(`DO $$ DECLARE f regprocedure; BEGIN FOR f IN ${functions} LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f); END LOOP; END $$`);
  }
}, 300_000);

test("a credential that can create roles and databases but owns nothing reaches the schema write and database replacement preflights of apply, restore and reset", async () => {
  await generateMigration(root, [exercises, entries, defineTable("notes", { columns: { id: column.uuid().generated().primaryKey() } })]);
  const stateDirectory = (await readdir(root)).find(name => /^[a-f0-9]{64}$/.test(name))!;
  const retained = (await readdir(join(root, stateDirectory))).find(name => /^before-.*\.dump$/.test(name))!;
  const creator = `${role}_creator`;
  // The profile plus role and database creation, including the self-grant the verification database needs.
  await control.unsafe(`CREATE ROLE ${creator} LOGIN PASSWORD '${password}' CREATEROLE CREATEDB IN ROLE ${role}`);
  await control.unsafe(`ALTER ROLE ${creator} SET createrole_self_grant = 'set, inherit'`);
  // Restore refuses while it cannot see that other sessions on the target are idle; PostgreSQL hides the state of
  // other roles' sessions without pg_read_all_stats, and the fixture's own superuser session stays connected.
  await control.unsafe(`GRANT pg_read_all_stats TO ${creator}`);
  try {
    const login = new URL(profileUrl);
    login.username = creator;
    const url = login.toString();
    const before = await observed();
    const apply = await cli(["db", "migration", "apply"], { FLEUR_PRIVATE_DATABASE_URL: url });
    expectShortfall(apply, "schema write");
    const restore = await cli(["db", "restore", "--from", join(root, stateDirectory, retained)], { FLEUR_PRIVATE_DATABASE_URL: url });
    expectShortfall(restore, "database replacement");
    const reset = await cli(["db", "reset"], { FLEUR_PRIVATE_DATABASE_URL: url, FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: url });
    expectShortfall(reset, "database replacement");
    for (const outcome of [apply, restore, reset]) expect(outcome.stdout).not.toContain(creator);
    expect(await observed()).toEqual(before);
    expect((await stateMarkers()).map(marker => marker.stage)).toEqual(["committed"]);
  } finally {
    await control.unsafe(`DROP ROLE ${creator}`);
    await rm(join(root, "migrations", "0002.json"));
  }
}, 300_000);

test("each missing privilege of the profile fails read-only inspection and status with DATABASE_PRIVILEGE_INSUFFICIENT naming its capability", async () => {
  const variants: { readonly name: string; readonly capability: string; readonly on: SQL; readonly revoke: string; readonly grant: string; readonly args: readonly (readonly string[])[] }[] = [
    { name: "control CONNECT", capability: "database connect", on: control, revoke: `REVOKE CONNECT ON DATABASE postgres FROM ${role}`, grant: `GRANT CONNECT ON DATABASE postgres TO ${role}`, args: [["db", "inspect"], ["status"]] },
    { name: "application CONNECT", capability: "database connect", on: control, revoke: `REVOKE CONNECT ON DATABASE privilege_app FROM ${role}`, grant: `GRANT CONNECT ON DATABASE privilege_app TO ${role}`, args: [["db", "inspect"], ["status"]] },
    { name: "control pg_control_system()", capability: "identity inspection", on: control, revoke: `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM ${role}`, grant: `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${role}`, args: [["db", "inspect"], ["status"]] },
    { name: "application pg_control_system()", capability: "identity inspection", on: admin, revoke: `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM ${role}`, grant: `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${role}`, args: [["db", "inspect"], ["status"]] },
    { name: "control advisory locks", capability: "maintenance locks", on: control, revoke: `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock_shared(bigint) FROM ${role}`, grant: `GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock_shared(bigint) TO ${role}`, args: [["db", "inspect"], ["status"]] },
    { name: "cursor key lock", capability: "maintenance locks", on: control, revoke: `REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) FROM ${role}`, grant: `GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) TO ${role}`, args: [["db", "inspect"]] },
    { name: "fleur_internal USAGE", capability: "schema read", on: admin, revoke: `REVOKE USAGE ON SCHEMA fleur_internal FROM ${role}`, grant: `GRANT USAGE ON SCHEMA fleur_internal TO ${role}`, args: [["db", "inspect"], ["db", "migration", "status"], ["status"]] },
    { name: "migration history SELECT", capability: "schema read", on: admin, revoke: `REVOKE SELECT ON fleur_internal.migrations FROM ${role}`, grant: `GRANT SELECT ON fleur_internal.migrations TO ${role}`, args: [["db", "inspect"], ["db", "migration", "status"], ["status"]] },
    { name: "public USAGE", capability: "schema read", on: admin, revoke: `REVOKE USAGE ON SCHEMA public FROM ${role}`, grant: `GRANT USAGE ON SCHEMA public TO ${role}`, args: [["db", "inspect", "--table", "exercises"]] },
    { name: "application table SELECT", capability: "schema read", on: admin, revoke: `REVOKE SELECT ON public.exercises FROM ${role}`, grant: `GRANT SELECT ON public.exercises TO ${role}`, args: [["db", "inspect", "--table", "exercises"]] },
  ];
  for (const variant of variants) {
    await variant.on.unsafe(variant.revoke);
    try {
      for (const args of variant.args) {
        const outcome = await cli([...args], profile());
        expect({ variant: variant.name, args, exit: outcome.exit, code: outcome.result.error?.code ?? null, capability: outcome.result.error?.expected?.capability ?? null }).toEqual({ variant: variant.name, args, exit: 4, code: "DATABASE_PRIVILEGE_INSUFFICIENT", capability: variant.capability });
        expectShortfall(outcome, variant.capability);
      }
    } finally { await variant.on.unsafe(variant.grant); }
  }
  // With every grant restored, the profile is sufficient again.
  const restored = await cli(["status"], profile());
  expect(restored.exit).toBe(0);
  expect(restored.result.data).toMatchObject({ reasons: [], database: { connectivity: "connected" } });
}, 300_000);
