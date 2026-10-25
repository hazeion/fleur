import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ownedPostgres } from "./owned-postgres";
import { column, defineTable } from "../../src/database";
import { generateMigration } from "../../src/runtime/database/migration-plan";
import { applyMigrations } from "../../src/runtime/database/migrations";

// The public command must collect declarations inside the native restricted worker.
test("db seed evaluates seeds modules only in the restricted worker and returns finite JSON", async () => {
  const fixture = await ownedPostgres(), root = await mkdtemp(join(tmpdir(), "fleur-seed-cli-"));
  const table = defineTable("cli_seed_rows", { columns: { id: column.safeInteger().primaryKey(), name: column.string() } });
  try {
    await mkdir(join(root, "server")); await mkdir(join(root, "seeds"));
    await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    await writeFile(join(root, "server/tables.ts"), 'import { column, defineTable } from "fleur/database"; export const rows=defineTable("cli_seed_rows",{columns:{id:column.safeInteger().primaryKey(),name:column.string()}});');
    await writeFile(join(root, "seeds/catalog.ts"), 'import { defineSeed } from "fleur/database"; import { rows } from "../server/tables"; export const catalog=defineSeed({key:"catalog",table:rows,rows:[{ownerKey:"first",values:{id:1,name:"From worker"}}]});');
    const config = { stateRoot: root, toolDirectory: await fixture.pgTools(join(root, "tools")) };
    await generateMigration(root, [table]); await applyMigrations(fixture.url, root, config);
    const run = async () => {
      const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), "db", "seed", "--project", root, "--json", "--timeout", "180"], { env: { ...process.env, FLEUR_PRIVATE_DATABASE_URL: fixture.url, FLEUR_PRIVATE_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(stderr).toBe(""); expect(stdout.trim().split("\n")).toHaveLength(1);
      return { exit, result: JSON.parse(stdout) };
    };
    expect(await run()).toMatchObject({ exit: 0, result: { formatVersion: 1, command: "db seed", ok: true, data: { inserted: 1, updated: 0, skipped: [] }, error: null, truncated: false } });
    expect(await fixture.sql.unsafe("SELECT name FROM public.cli_seed_rows")).toEqual([{ name: "From worker" }]);
    await writeFile(join(root, "seeds/catalog.ts"), 'import { writeFileSync } from "node:fs"; writeFileSync("sentinel","forbidden");');
    expect(await run()).toMatchObject({ exit: 1, result: { ok: false, error: { code: "SOURCE_REJECTED" } } });
    expect(await Bun.file(join(root, "sentinel")).exists()).toBe(false);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 300_000);
