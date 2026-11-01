import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DevelopmentPostgres, databaseLabel } from "../../src/runtime/development/postgres";
import { binding } from "../../src/runtime/development/state";
import { column, defineTable, defineSeed } from "../../src/database";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { startDevelopmentDatabase } from "../../src/runtime/database/development";
import { backupDatabase } from "../../src/runtime/database/backup";
import { restoreDatabase } from "../../src/runtime/database/restore";
import { resetDatabase } from "../../src/runtime/database/reset";

async function docker(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error("Disposable development fixture cleanup failed");
  return out.trim();
}
async function cli(root: string, args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), "db", "query", ...args, "--project", root, "--json"], { env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe("");
  return { out, exit, result: JSON.parse(out) };
}
test("public db query uses owned development storage after initialization, restart, restore and reset", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fleur-owned-query-"));
  await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, contractVersion: 1, fleurVersion: "0.1.0", compiler: "microsoft", projectId: crypto.randomUUID() }));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { fleur: "0.1.0" } }));
  const bound = await binding(root), config = { stateRoot: join(bound.directory, "maintenance") };
  let resource: DevelopmentPostgres | undefined, sql: SQL | undefined;
  try {
    resource = await DevelopmentPostgres.start(bound, performance.now() + 30000);
    const url = await resource.url(), controlUrl = await resource.url("postgres"), toolDirectory = await resource.tools();
    const maintenance = { ...config, controlUrl, toolDirectory, timeoutMs: 60000 };
    const table = defineTable("diagnostic_rows", { columns: { id: column.safeInteger().primaryKey(), label: column.string() } });
    const seed = defineSeed({ key: "sample", table, rows: [{ ownerKey: "one", values: { id: 1, label: "preserved" } }] });
    await generateMigration(root, [table]);
    expect(await startDevelopmentDatabase({ url, binding: bound.id }, root, [seed], maintenance)).toMatchObject({ ready: true });
    await resource.bindApplication(maintenance);
    const read = async () => {
      const outcome = await cli(root, ["--sql", "SELECT label FROM diagnostic_rows"], { FLEUR_PRIVATE_DATABASE_URL: "postgres://ignored:ignored@uncontacted.invalid/production" });
      expect(outcome.exit).toBe(0); expect(outcome.result.data.rows).toEqual([["preserved"]]);
      for (const secret of ["fleur_agent_query_v1", new URL(url).password, "127.0.0.1", new URL(url).port, url]) expect(outcome.out).not.toContain(secret);
    };
    await read();
    const values = ["--json", "-7", "", "x'); DELETE FROM diagnostic_rows; --", "emoji 🌱\nline"];
    await writeFile(join(root, "read.sql"), "SELECT $1::text AS a,$2::text AS b,$3::text AS c,$4::text AS d,$5::text AS e");
    const boundValues = await cli(root, ["--sql-file", "read.sql", ...values.flatMap(value => ["--param", value])]);
    expect(boundValues.exit).toBe(0); expect(boundValues.result.data.rows).toEqual([values]);
    const rejected = await cli(root, ["--sql", "SELECT * FROM fleur_internal.migrations"]);
    expect(rejected.exit).toBe(1); expect(rejected.result.error).toMatchObject({ code: "DATABASE_QUERY_REJECTED", actual: { sqlstate: "42501" } });
    expect(rejected.out).not.toContain("fleur_agent_query_v1");
    const before = JSON.parse(await readFile(join(bound.directory, "postgres.json"), "utf8"));
    await resource.stop();
    expect((await cli(root, ["--sql", "SELECT 1"])).result.error.code).toBe("DATABASE_UNAVAILABLE");
    resource = await DevelopmentPostgres.start(bound, performance.now() + 30000);
    const after = JSON.parse(await readFile(join(bound.directory, "postgres.json"), "utf8"));
    expect(after.queryPassword).not.toBe(before.queryPassword);
    await resource.bindApplication({ ...maintenance, controlUrl: await resource.url("postgres") }); await read();
    // Ports can change on restart. Trusted tools and URLs are selected afresh.
    const live = await resource.url(), liveConfig = { ...maintenance, controlUrl: await resource.url("postgres") };
    const archive = join(root, "retained.dump");
    expect(await backupDatabase(live, archive, liveConfig)).toMatchObject({ verified: true, cleanupVerified: true });
    sql = new SQL(live); await sql.unsafe("UPDATE diagnostic_rows SET label='changed'"); await sql.close(); sql = undefined;
    expect(await restoreDatabase(live, root, archive, { ...liveConfig, confirm: async () => true })).toMatchObject({ restored: true });
    await read();
    expect(await resetDatabase(live, root, [seed], { ...liveConfig, developmentUrl: live, seed: true, confirm: async () => true })).toMatchObject({ reset: true });
    await read();
  } finally {
    await sql?.close(); await resource?.stop().catch(() => {});
    const record = JSON.parse(await readFile(join(bound.directory, "postgres.json"), "utf8"));
    const metadata = JSON.parse(await docker(["inspect", record.container, "--format", "{{json .}}"]));
    expect(metadata.Config.Labels[databaseLabel]).toBe(bound.id);
    if (metadata.State.Running) await docker(["stop", "--time", "1", record.container]);
    await docker(["rm", record.container]);
    const volume = JSON.parse(await docker(["volume", "inspect", record.volume, "--format", "{{json .}}"]));
    expect(volume.Labels[databaseLabel]).toBe(bound.id);
    await docker(["volume", "rm", record.volume]);
    await rm(bound.directory, { recursive: true, force: true }); await rm(root, { recursive: true, force: true });
  }
}, 240000);
