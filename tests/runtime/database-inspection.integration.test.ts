import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedPostgres } from "./owned-postgres";

test("CLI inspection paginates exact data, exports integrity metadata and cannot overwrite destinations", async () => {
  const fixture = await ownedPostgres();
  const root = await mkdtemp(join(tmpdir(), "fleur-inspect-"));
  try {
    await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    await fixture.sql.unsafe("CREATE TABLE inspections (id bigint PRIMARY KEY, amount numeric NOT NULL, version bigint NOT NULL DEFAULT 1)");
    await fixture.sql.unsafe("INSERT INTO inspections(id,amount) VALUES (2,9007199254740993.01),(10,0.10),(20,1.00)");
    async function invoke(args: string[]) {
      const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), "db", "inspect", "--project", root, "--json", ...args], { env: { ...process.env, FLEUR_PRIVATE_DATABASE_URL: fixture.url, FLEUR_PRIVATE_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
      const [text, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(error).toBe("");
      return { exit, result: JSON.parse(text) as { ok: boolean; truncated: boolean; data: { rows: { id: string; amount: string; version: string }[]; cursor: string | null; export: { sha256: string; bytes: number; complete: boolean } }; error: { code: string } } };
    }
    const first = await invoke(["--table", "inspections", "--limit", "1"]);
    expect(first.exit).toBe(0);
    expect(first.result.data.rows).toEqual([{ id: "2", amount: "9007199254740993.01", version: "1" }]);
    expect(first.result.truncated).toBe(true);
    expect(first.result.data.cursor).toBeString();
    const second = await invoke(["--table", "inspections", "--limit", "1", "--cursor", first.result.data.cursor!]);
    expect(second.result.data.rows[0]?.id).toBe("10");
    const destination = join(root, "page.json");
    const exported = await invoke(["--table", "inspections", "--export", destination]);
    expect(exported.exit).toBe(0);
    const contents = await Bun.file(destination).text();
    expect(exported.result.data.rows).toEqual([]);
    expect(exported.result.data.export).toMatchObject({ complete: true, bytes: Buffer.byteLength(contents), sha256: new Bun.CryptoHasher("sha256").update(contents).digest("hex") });
    const collision = await invoke(["--table", "inspections", "--export", destination]);
    expect(collision.exit).not.toBe(0);
    expect(await Bun.file(destination).text()).toBe(contents);
    const tampered = await invoke(["--table", "inspections", "--cursor", first.result.data.cursor!+"x"]);
    expect(tampered.result.error.code).toBe("ARGUMENT_INVALID");
    expect(tampered.exit).toBe(2);
  } finally { await fixture.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 180_000);
