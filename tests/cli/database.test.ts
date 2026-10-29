import { expect, test } from "bun:test";
import { resolve } from "node:path";

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  return { exit, result: JSON.parse(stdout) as { command: string; ok: boolean; data: { commands: { name: string; usage: string }[] }; error: { code: string } | null } };
}
test("database inspection, verified backup and read-only recovery are discoverable named commands", async () => {
  const { exit, result } = await cli(["--help"]);
  expect(exit).toBe(0);
  expect(result.data.commands.map(command => command.name)).toContain("db inspect");
  expect(result.data.commands.map(command => command.name)).toContain("db backup");
  expect(result.data.commands.map(command => command.name)).toContain("db recover");
});

test("database commands reject positional SQL and incomplete backup/recovery grammar before configuration", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(`${tmpdir()}/fleur-db-grammar-`);
  try {
    await writeFile(`${root}/fleur.json`, JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    for (const args of [["db", "inspect", "SELECT * FROM ingredients"], ["db", "backup"], ["db", "recover"], ["db", "inspect", "--limit", "501"], ["db", "inspect", "--cursor", "bad"]]) {
      const outcome = await cli([...args, "--project", root]);
      expect(outcome.exit).toBe(2);
      expect(outcome.result.error?.code).toBe("ARGUMENT_INVALID");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an existing backup destination is an operation failure and preserves the file", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(`${tmpdir()}/fleur-backup-collision-`);
  try {
    await writeFile(`${root}/fleur.json`, JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
    await writeFile(`${root}/existing.dump`, "unrelated content");
    const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), "db", "backup", "--out", `${root}/existing.dump`, "--project", root, "--json"], { env: { ...process.env, FLEUR_PRIVATE_DATABASE_URL: "postgres://uncontacted@127.0.0.1/uncontacted" }, stdout: "pipe", stderr: "pipe" });
    const [text, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(errors).toBe("");
    expect(exit).toBe(1);
    expect(JSON.parse(text).error.code).toBe("DESTINATION_EXISTS");
    expect(await Bun.file(`${root}/existing.dump`).text()).toBe("unrelated content");
  } finally { await rm(root, { recursive: true, force: true }); }
});
