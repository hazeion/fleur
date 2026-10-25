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
    for (const args of [["db", "inspect", "SELECT * FROM exercises"], ["db", "backup"], ["db", "recover"], ["db", "inspect", "--limit", "501"], ["db", "inspect", "--cursor", "bad"]]) {
      const outcome = await cli([...args, "--project", root]);
      expect(outcome.exit).toBe(2);
      expect(outcome.result.error?.code).toBe("ARGUMENT_INVALID");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
