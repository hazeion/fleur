import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedPostgres } from "./owned-postgres";
import { column, defineTable } from "../../src/database";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations } from "../../src/runtime/database/migrations";
import { MaintenanceLease } from "../../src/runtime/database/maintenance";

// Requirements: docs/planning/V1-SPEC.md "Schema inspection and database health" (#72).
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Outcome { exit: number; stdout: string; result: { ok: boolean; truncated: boolean; data: Record<string, Json>; error: { code: string } | null } }
async function cli(root: string, args: string[], env: Record<string, string>): Promise<Outcome> {
  const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), ...args, "--project", root, "--json"], { env: { ...process.env, FLEUR_PRIVATE_STATE_ROOT: root, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  return { exit, stdout, result: JSON.parse(stdout) };
}
async function project(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
  return root;
}
/** A separately named application database in the owned cluster, so the database name never equals the login user. */
async function applicationDatabase(fixture: Awaited<ReturnType<typeof ownedPostgres>>, name: string) {
  await fixture.sql.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(fixture.url);
  url.pathname = `/${name}`;
  return { url: url.toString(), sql: new SQL(url.toString(), { max: 1, connectionTimeout: 2 }), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), port: Number(url.port) };
}
function expectNoEndpoint(outcome: Outcome, target: { url: string; user: string; password: string; port: number }) {
  for (const secret of [target.url, target.user, target.password, "127.0.0.1", "postgres://", "postgresql://"]) expect(outcome.stdout).not.toContain(secret);
  const values: unknown[] = [];
  const walk = (value: unknown) => { if (value && typeof value === "object") Object.values(value).forEach(walk); else values.push(value); };
  walk(outcome.result);
  expect(values).not.toContain(target.port);
  expect(values).not.toContain(String(target.port));
}

function workoutTables() {
  const exercises = defineTable("exercises", { columns: {
    id: column.uuid().generated().primaryKey(),
    name: column.string().max(100).unique({ caseFold: true }),
    createdAt: column.timestamp().defaultNow(),
  } });
  const templates = defineTable("templates", { columns: {
    id: column.safeInteger().generated().primaryKey(),
    name: column.string().max(100),
    notes: column.string().nullable(),
  } });
  const templateEntries = defineTable("template_entries", { versioned: false, columns: {
    id: column.safeInteger().generated().primaryKey(),
    templateId: column.safeInteger().references(templates.id, { onDelete: "cascade" }),
    exerciseId: column.uuid().references(exercises.id, { onDelete: "restrict" }),
    position: column.safeInteger().unique(),
    sets: column.safeInteger().default(3),
  } });
  const sessions = defineTable("sessions", { columns: {
    id: column.uuid().generated().primaryKey(),
    performedOn: column.localDate(),
    templateId: column.safeInteger().nullable().references(templates.id, { onDelete: "set null" }),
    weight: column.decimal({ precision: 6, scale: 2 }).nullable(),
  } });
  return [exercises, templates, templateEntries, sessions];
}

test("the schema overview reports every structural element of the workout fixture without rows or endpoint details", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-workout-");
  try {
    const target = await applicationDatabase(fixture, "workout_app");
    try {
      const tools = await fixture.pgTools(join(root, "tools"));
      await generateMigration(root, workoutTables());
      expect((await applyMigrations(target.url, root, { stateRoot: root, toolDirectory: tools })).applied).toEqual(["0001"]);
      await target.sql.unsafe("INSERT INTO exercises(name) VALUES ('Row data that must not appear')");
      const env = { FLEUR_PRIVATE_DATABASE_URL: target.url };
      const overview = await cli(root, ["db", "inspect"], env);
      expect(overview.result.error).toBeNull();
      expect(overview.exit).toBe(0);
      expect(overview.stdout).not.toContain("Row data that must not appear");
      expect(overview.stdout).not.toContain("fleur_internal");
      expect(overview.result.truncated).toBe(false);
      const data = overview.result.data;
      expect(data.view).toBe("overview");
      expect(data.rows).toBeUndefined();
      expect(data.cursor).toBeNull();
      expect(data.target).toMatchObject({ kind: "development", database: "workout_app" });
      expect((data.target as Record<string, Json>).serverVersion).toMatch(/^18\./);
      expect((data.target as Record<string, Json>).fingerprint).toMatch(/^[a-f0-9]{32}$/);
      expect(data.migrations).toEqual({ compatible: true, applied: ["0001"], pending: [], drift: false, differenceCount: 0, maintenance: { state: "idle", stage: "committed" } });
      interface Described { name: string; indexes: { name: string; columns: string[] }[]; foreignKeys: { name: string; columns: string[] }[]; primaryKey: { name: string } }
      const tables = data.tables as unknown as Described[];
      expect(tables.map(table => table.name)).toEqual(["exercises", "sessions", "template_entries", "templates"]);
      const named = (table: string) => tables.find(item => item.name === table)!;
      const described = (table: string): unknown => named(table);
      const uniqueName = (table: string, field: string) => named(table).indexes.find(index => index.name.startsWith("fleur_unique_") && index.columns.includes(field))!.name;
      expect(described("exercises")).toEqual({
        name: "exercises", versioned: true,
        columns: [
          { name: "id", type: "uuid", kind: "uuid", nullable: false, default: "gen_random_uuid()", identity: false, managed: true },
          { name: "name", type: "text", kind: "string", nullable: false, default: null, identity: false, managed: false },
          { name: "createdAt", type: "timestamp with time zone", kind: "timestamp", nullable: false, default: "CURRENT_TIMESTAMP", identity: false, managed: false },
          { name: "version", type: "bigint", kind: "safeInteger", nullable: false, default: "1", identity: false, managed: true },
        ],
        primaryKey: { name: named("exercises").primaryKey.name, columns: ["id"] },
        foreignKeys: [],
        uniqueConstraints: [],
        indexes: [{ name: uniqueName("exercises", "name"), unique: true, columns: ["name"], caseFolded: true, definition: expect.stringContaining("fleur_casefold_17") }],
      });
      expect(described("template_entries")).toEqual({
        name: "template_entries", versioned: false,
        columns: [
          { name: "id", type: "bigint", kind: "safeInteger", nullable: false, default: null, identity: true, managed: true },
          { name: "templateId", type: "bigint", kind: "safeInteger", nullable: false, default: null, identity: false, managed: false },
          { name: "exerciseId", type: "uuid", kind: "uuid", nullable: false, default: null, identity: false, managed: false },
          { name: "position", type: "bigint", kind: "safeInteger", nullable: false, default: null, identity: false, managed: false },
          { name: "sets", type: "bigint", kind: "safeInteger", nullable: false, default: "3", identity: false, managed: false },
        ],
        primaryKey: { name: named("template_entries").primaryKey.name, columns: ["id"] },
        foreignKeys: [
          { name: named("template_entries").foreignKeys.find(key => key.columns[0] === "exerciseId")!.name, columns: ["exerciseId"], references: { table: "exercises", columns: ["id"] }, onDelete: "restrict" },
          { name: named("template_entries").foreignKeys.find(key => key.columns[0] === "templateId")!.name, columns: ["templateId"], references: { table: "templates", columns: ["id"] }, onDelete: "cascade" },
        ].sort((a, b) => a.name < b.name ? -1 : 1),
        uniqueConstraints: [],
        indexes: [{ name: uniqueName("template_entries", "position"), unique: true, columns: ["position"], caseFolded: false, definition: expect.stringContaining("UNIQUE INDEX") }],
      });
      expect(described("sessions")).toMatchObject({
        versioned: true,
        columns: [
          { name: "id", kind: "uuid", managed: true },
          { name: "performedOn", type: "date", kind: "localDate", nullable: false },
          { name: "templateId", type: "bigint", kind: "safeInteger", nullable: true },
          { name: "weight", type: "numeric(6,2)", kind: "decimal", nullable: true, default: null },
          { name: "version", kind: "safeInteger", managed: true },
        ],
        foreignKeys: [{ columns: ["templateId"], references: { table: "templates", columns: ["id"] }, onDelete: "set null" }],
      });
      expect(described("templates")).toMatchObject({ versioned: true, columns: [{ name: "id", identity: true, managed: true }, { name: "name" }, { name: "notes", nullable: true }, { name: "version", managed: true }] });
      // A table outside the reviewed declarations is still described from the catalog, with unknown Fleur metadata,
      // and PostgreSQL unique constraints are reported separately from indexes.
      await target.sql.unsafe("CREATE TABLE external_notes(code text PRIMARY KEY, label text UNIQUE)");
      const unmanaged = await cli(root, ["db", "inspect"], env);
      const external: unknown = (unmanaged.result.data.tables as unknown as { name: string }[]).find(table => table.name === "external_notes");
      expect(external).toEqual({
        name: "external_notes", versioned: null,
        columns: [
          { name: "code", type: "text", kind: null, nullable: false, default: null, identity: false, managed: false },
          { name: "label", type: "text", kind: null, nullable: true, default: null, identity: false, managed: false },
        ],
        primaryKey: { name: "external_notes_pkey", columns: ["code"] }, foreignKeys: [],
        uniqueConstraints: [{ name: "external_notes_label_key", columns: ["label"] }], indexes: [],
      });
      const status = await cli(root, ["status"], env);
      expect(status.exit).toBe(0);
      const table = await cli(root, ["db", "inspect", "--table", "exercises"], env);
      expect(table.exit).toBe(0);
      expect(table.result.data.view).toBe("table");
      expect(table.result.data.structure).toEqual(described("exercises") as Json);
      for (const outcome of [overview, unmanaged, status, table]) expectNoEndpoint(outcome, target);
    } finally { await target.sql.close({ timeout: 0 }); }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("an overview larger than one page reports truncation by count and by encoded bytes and resumes from its cursor", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-pages-");
  try {
    const env = { FLEUR_PRIVATE_DATABASE_URL: fixture.url };
    for (const name of ["page_a", "page_b", "page_c"]) await fixture.sql.unsafe(`CREATE TABLE ${name}(id bigint PRIMARY KEY)`);
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page: Outcome = await cli(root, ["db", "inspect", "--limit", "2", ...(cursor ? ["--cursor", cursor] : [])], env);
      expect(page.exit).toBe(0);
      pages++;
      const names = (page.result.data.tables as { name: string }[]).map(table => table.name);
      seen.push(...names);
      cursor = page.result.data.cursor as string | null;
      expect(page.result.truncated).toBe(cursor !== null);
      expect(page.result.data.truncated).toBe(cursor !== null);
    } while (cursor);
    expect(pages).toBe(2);
    expect(seen).toEqual(["page_a", "page_b", "page_c"]);
    // Sixty wide tables exceed the encoded byte cap long before the default 100-table limit.
    const wide = Array.from({ length: 300 }, (_, index) => `${"c".repeat(56)}_${String(index).padStart(3, "0")} text`).join(",");
    for (let index = 0; index < 60; index++) await fixture.sql.unsafe(`CREATE TABLE wide_${String(index).padStart(2, "0")}(id bigint PRIMARY KEY, ${wide})`);
    const listed: string[] = [];
    cursor = null;
    let truncatedPages = 0;
    do {
      const page: Outcome = await cli(root, ["db", "inspect", ...(cursor ? ["--cursor", cursor] : [])], env);
      expect(page.result.error).toBeNull();
      expect(Buffer.byteLength(page.stdout)).toBeLessThanOrEqual(1024 * 1024);
      listed.push(...(page.result.data.tables as { name: string }[]).map(table => table.name));
      cursor = page.result.data.cursor as string | null;
      if (cursor) truncatedPages++;
    } while (cursor);
    expect(truncatedPages).toBeGreaterThan(0);
    expect(listed).toEqual(["page_a", "page_b", "page_c", ...Array.from({ length: 60 }, (_, index) => `wide_${String(index).padStart(2, "0")}`)]);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("drift, a pending migration and an active maintenance stage appear in db inspect, status and db migration status with the same summary", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-summary-");
  try {
    const target = await applicationDatabase(fixture, "summary_app");
    try {
      const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
      const exercises = defineTable("exercises", { columns: { id: column.uuid().primaryKey(), name: column.string().max(100) } });
      await generateMigration(root, [exercises]);
      await applyMigrations(target.url, root, config);
      await generateMigration(root, [exercises, defineTable("notes", { columns: { id: column.uuid().primaryKey() } })]);
      await target.sql.unsafe("ALTER TABLE exercises ALTER COLUMN name DROP NOT NULL");
      const env = { FLEUR_PRIVATE_DATABASE_URL: target.url };
      const lease = await MaintenanceLease.acquire(target.url, true, config, true);
      try {
        expect(lease.busy).toBe(false);
        await lease.persist({ ...(await lease.marker())!, stage: "preparing" });
        const migration = await cli(root, ["db", "migration", "status"], env);
        const overview = await cli(root, ["db", "inspect"], env);
        const rows = await cli(root, ["db", "inspect", "--table", "exercises"], env);
        const status = await cli(root, ["status"], env);
        for (const outcome of [migration, overview, rows, status]) {
          expect(outcome.result.error).toBeNull();
          expect(outcome.exit).toBe(0);
          expectNoEndpoint(outcome, target);
        }
        const summary = migration.result.data.migrations;
        expect(summary).toEqual({ compatible: false, applied: ["0001"], pending: ["0002"], drift: true, differenceCount: 1, maintenance: { state: "active", stage: "preparing" } });
        expect(overview.result.data.migrations).toEqual(summary);
        expect(rows.result.data.migrations).toEqual(summary);
        expect((status.result.data.database as Record<string, Json>).migrations).toEqual(summary);
        expect(migration.result.data.differences).toEqual([{ object: "column exercises.name", expected: 'text collate "C" not null', actual: 'text collate "C"' }]);
        expect(migration.result.data.differencesTruncated).toBe(false);
        const reasons = (status.result.data.reasons as { code: string; action: { command: string } }[]);
        expect(reasons.map(reason => reason.code)).toEqual(["MIGRATION_PENDING", "SCHEMA_DRIFT", "MAINTENANCE_ACTIVE"]);
        for (const reason of reasons) expect(reason.action.command).toStartWith("fleur ");
        expect(status.result.data).toMatchObject({ ready: false, database: { connectivity: "connected", target: { kind: "development", database: "summary_app" } } });
      } finally { await lease.close(); }
      // After the owner is gone, the unfinished stage is reported as recovery rather than active maintenance.
      const interrupted = await cli(root, ["status"], env);
      expect(interrupted.exit).toBe(0);
      expect(((interrupted.result.data.database as Record<string, Json>).migrations as Record<string, Json>).maintenance).toEqual({ state: "recovery required", stage: "preparing" });
      expect((interrupted.result.data.reasons as { code: string }[]).map(reason => reason.code)).toEqual(["MIGRATION_PENDING", "SCHEMA_DRIFT", "RECOVERY_REQUIRED"]);
    } finally { await target.sql.close({ timeout: 0 }); }
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("status against a stopped database exits 0 within its probe deadline and points to the database", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-stopped-");
  try {
    const target = await applicationDatabase(fixture, "stopped_app");
    await target.sql.close({ timeout: 0 });
    await fixture.sql.unsafe("DROP DATABASE stopped_app");
    const started = performance.now();
    const status = await cli(root, ["status"], { FLEUR_PRIVATE_DATABASE_URL: target.url });
    expect(performance.now() - started).toBeLessThan(5_000 + 3_000);
    expect(status.exit).toBe(0);
    expect(status.result.data).toMatchObject({ ready: false, database: { connectivity: "unreachable", failure: "rejected", target: { kind: "development", database: "stopped_app", serverVersion: null, fingerprint: null }, migrations: null } });
    expect((status.result.data.reasons as { code: string }[]).map(reason => reason.code)).toEqual(["DATABASE_UNAVAILABLE"]);
    const rows = await cli(root, ["db", "inspect", "--table", "exercises"], { FLEUR_PRIVATE_DATABASE_URL: target.url });
    expect(rows.exit).toBe(4);
    expect(rows.result.error?.code).toBe("DATABASE_UNAVAILABLE");
    for (const outcome of [status, rows]) expectNoEndpoint(outcome, target);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("the status probe stops at its own 5 s default deadline, adjusted by --timeout, when the database stops answering", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-deadline-");
  try {
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [defineTable("held", { columns: { id: column.uuid().primaryKey() } })]);
    await applyMigrations(fixture.url, root, config);
    const env = { FLEUR_PRIVATE_DATABASE_URL: fixture.url };
    const holder = await fixture.sql.reserve();
    try {
      await holder.unsafe("BEGIN");
      await holder.unsafe("LOCK TABLE fleur_internal.migrations IN ACCESS EXCLUSIVE MODE");
      for (const [args, deadline] of [[["status", "--timeout", "2"], 2_000], [["status"], 5_000]] as const) {
        const started = performance.now();
        const status = await cli(root, [...args], env);
        const elapsed = performance.now() - started;
        expect(status.exit).toBe(0);
        expect(status.result.data).toMatchObject({ database: { connectivity: "unreachable", failure: "timeout", migrations: null } });
        expect((status.result.data.reasons as { code: string }[]).map(reason => reason.code)).toEqual(["DATABASE_UNAVAILABLE"]);
        expect(elapsed).toBeGreaterThanOrEqual(deadline - 250);
        expect(elapsed).toBeLessThan(deadline + 3_000);
      }
      // A statement timeout in db inspect is the same timeout finding, not an internal failure.
      const inspected = await cli(root, ["db", "inspect", "--table", "held", "--timeout", "30"], env);
      expect(inspected.exit).toBe(4);
      expect(inspected.result.error?.code).toBe("DATABASE_UNAVAILABLE");
    } finally { await holder.unsafe("ROLLBACK").catch(() => {}); holder.release(); }
    const answered = await cli(root, ["status"], env);
    expect(answered.result.data).toMatchObject({ database: { connectivity: "connected", migrations: { compatible: true } } });
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("the inspection transaction is read-only in PostgreSQL, and a failed inspection never publishes its export", async () => {
  const { withInspection } = await import("../../src/runtime/database/target");
  const { inspectDatabase } = await import("../../src/runtime/database/inspection");
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-readonly-");
  try {
    await fixture.sql.unsafe("CREATE TABLE guarded(id bigint PRIMARY KEY); INSERT INTO guarded VALUES (1)");
    // PostgreSQL, not Fleur code, refuses writes inside the host-opened transaction, and it cannot become read-write.
    const refused = await withInspection(fixture.url, "development", { stateRoot: root }, async ({ sql }) => {
      const codes: Record<string, unknown> = {};
      for (const statement of ["INSERT INTO public.guarded VALUES (2)", "UPDATE public.guarded SET id = 3", "DELETE FROM public.guarded", "CREATE TABLE public.written(id integer)", "SET TRANSACTION READ WRITE"]) {
        await sql.unsafe("SAVEPOINT attempt");
        codes[statement] = await sql.unsafe(statement).then(() => "accepted", (error: { errno?: unknown }) => error.errno);
        await sql.unsafe("ROLLBACK TO SAVEPOINT attempt");
      }
      return codes;
    });
    expect(refused).toEqual({ "INSERT INTO public.guarded VALUES (2)": "25006", "UPDATE public.guarded SET id = 3": "25006", "DELETE FROM public.guarded": "25006", "CREATE TABLE public.written(id integer)": "25006", "SET TRANSACTION READ WRITE": "25001" });
    expect(await fixture.sql.unsafe("SELECT id::text AS id, to_regclass('public.written') IS NULL AS absent FROM guarded")).toEqual([{ id: "1", absent: true }]);

    // An inspection that fails at its deadline publishes nothing, even after the blocked statement ends.
    const blocked = join(root, "blocked-page.json");
    const holder = await fixture.sql.reserve();
    try {
      await holder.unsafe("BEGIN");
      await holder.unsafe("LOCK TABLE guarded IN ACCESS EXCLUSIVE MODE");
      await expect(inspectDatabase(fixture.url, { project: root, table: "guarded", export: blocked }, { stateRoot: root, timeoutMs: 1500 })).rejects.toThrow("DATABASE_UNAVAILABLE");
    } finally { await holder.unsafe("ROLLBACK").catch(() => {}); holder.release(); }
    await Bun.sleep(6_000);
    expect(await Bun.file(blocked).exists()).toBe(false);

    // Publication slower than the deadline: either the command reports success with the published file, or it reports
    // failure and leaves no file. Isolate the filesystem boundary injection in a child process.
    const slow = join(root, "slow-page.json");
    const child = Bun.spawn([process.execPath, "--eval", `
      import { mock } from "bun:test";
      import * as filesystem from "node:fs/promises";
      const destination = process.env.REVIEW_DESTINATION;
      const originalLink = filesystem.link;
      let delayed = false;
      mock.module("node:fs/promises", () => ({ ...filesystem, link: async (from, to) => {
        if (String(to) === destination) { delayed = true; await Bun.sleep(3000); }
        return originalLink(from, to);
      }}));
      const { inspectDatabase } = await import(${JSON.stringify(resolve("src/runtime/database/inspection.ts"))});
      const outcome = await inspectDatabase(process.env.REVIEW_DATABASE_URL, { project: process.env.REVIEW_ROOT, table: "guarded", export: destination }, { stateRoot: process.env.REVIEW_ROOT, timeoutMs: 1500 })
        .then(result => ({ ok: true, sha256: result.data.export.sha256 }), error => ({ ok: false, error: error.message }));
      await Bun.sleep(4000);
      console.log(JSON.stringify({ ...outcome, delayed }));
    `], { env: { ...process.env, REVIEW_DATABASE_URL: fixture.url, REVIEW_ROOT: root, REVIEW_DESTINATION: slow }, stdout: "pipe", stderr: "pipe" });
    const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    const outcome = JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; delayed: boolean; sha256?: string; error?: string };
    // The slow publication path must actually run, and the only admissible failure is the deadline.
    expect(outcome.delayed).toBe(true);
    if (!outcome.ok) expect(outcome.error).toBe("DATABASE_UNAVAILABLE");
    const published = await Bun.file(slow).exists();
    expect({ ok: outcome.ok, published }).toEqual({ ok: outcome.ok, published: outcome.ok });
    if (outcome.ok) expect(new Bun.CryptoHasher("sha256").update(await Bun.file(slow).text()).digest("hex")).toBe(outcome.sha256!);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("status keeps the maintenance stage of a replaced target, points prerequisites to doctor, and drift differences stay within their byte bound", async () => {
  const fixture = await ownedPostgres();
  const root = await project("fleur-overview-replaced-");
  try {
    const target = await applicationDatabase(fixture, "replaced_app");
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [defineTable("bounded", { columns: { id: column.uuid().primaryKey(), label: column.string() } })]);
    await applyMigrations(target.url, root, config);
    const env = { FLEUR_PRIVATE_DATABASE_URL: target.url };
    for (let index = 0; index < 120; index++) await target.sql.unsafe(`ALTER TABLE bounded ADD CONSTRAINT wide_${index} CHECK (label <> '${"w".repeat(9000)}')`);
    const migration = await cli(root, ["db", "migration", "status"], env);
    expect(migration.exit).toBe(0);
    expect(Buffer.byteLength(migration.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(migration.result.truncated).toBe(true);
    expect(migration.result.data.differencesTruncated).toBe(true);
    expect((migration.result.data.migrations as Record<string, Json>).differenceCount).toBe(120);
    const listed = (migration.result.data.differences as Json[]).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(120);

    // A local prerequisite, here an unusable private state directory, is a finding whose action points to doctor.
    await writeFile(join(root, "not-a-directory"), "");
    const prerequisite = await cli(root, ["status"], { ...env, FLEUR_PRIVATE_STATE_ROOT: join(root, "not-a-directory", "state") });
    expect(prerequisite.exit).toBe(0);
    expect(prerequisite.result.data).toMatchObject({ database: { connectivity: "unknown", maintenance: null, migrations: null }, reasons: [{ code: "PREREQUISITE_UNAVAILABLE", action: { command: "fleur doctor" } }] });

    // A target replaced by maintenance is reported through the maintenance record, not as a stopped server.
    const lease = await MaintenanceLease.acquire(target.url, true, config, true);
    try {
      await lease.persist({ ...(await lease.marker())!, stage: "applying" });
      await target.sql.close({ timeout: 0 });
      await fixture.sql.unsafe("DROP DATABASE replaced_app WITH (FORCE)");
      const active = await cli(root, ["status"], env);
      expect(active.exit).toBe(0);
      expect(active.result.data).toMatchObject({ database: { connectivity: "unreachable", failure: "rejected", maintenance: { state: "active", stage: "applying" }, migrations: null } });
      expect((active.result.data.reasons as { code: string }[]).map(reason => reason.code)).toEqual(["MAINTENANCE_ACTIVE"]);
    } finally { await lease.close(); }
    const interrupted = await cli(root, ["status"], env);
    expect(interrupted.result.data).toMatchObject({ database: { connectivity: "unreachable", maintenance: { state: "recovery required", stage: "applying" } } });
    expect((interrupted.result.data.reasons as { code: string }[]).map(reason => reason.code)).toEqual(["RECOVERY_REQUIRED"]);
    expectNoEndpoint(interrupted, target);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);

test("status reports a control database in another cluster as configuration to correct, not as maintenance", async () => {
  const [application, control] = [await ownedPostgres(), await ownedPostgres()];
  const root = await project("fleur-overview-mismatch-");
  try {
    const controlUrl = new URL(control.url);
    controlUrl.pathname = "/postgres";
    const status = await cli(root, ["status"], { FLEUR_PRIVATE_DATABASE_URL: application.url, FLEUR_PRIVATE_CONTROL_DATABASE_URL: controlUrl.toString() });
    expect(status.exit).toBe(4);
    expect(status.result.error?.code).toBe("CONFIGURATION_MISSING");
    const actions = (status.result.error as unknown as { actions: { command: string; description: string }[] }).actions;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.command).toBe("fleur status");
    expect(actions[0]!.description).toContain("FLEUR_PRIVATE_CONTROL_DATABASE_URL");
    for (const secret of [application.url, control.url, "127.0.0.1"]) expect(status.stdout).not.toContain(secret);
  } finally { await application.cleanup(); await control.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);
