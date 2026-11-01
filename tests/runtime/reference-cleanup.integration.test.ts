import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ownedPostgres } from "./owned-postgres";

test("a paused-listener resume failure still retires the owned database and disk volume", async () => {
  const database = await ownedPostgres({ disk: true });
  const originalPath = process.env.PATH;
  const docker = Bun.which("docker")!;
  const root = await mkdtemp(join(tmpdir(), "fleur-cleanup-failure-"));
  const name = (await database.sql`SELECT current_database() AS name`)[0].name as string;
  const owner = name.slice("fleur_read_".length);
  try {
    await database.sql.listen("fleur_revision", () => {});
    await database.pauseNotifications();
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    await writeFile(join(root, "docker"), `#!/bin/sh\nif [ "$1" = exec ] && [ "$3" = kill ] && [ "$4" = -CONT ]; then exit 71; fi\nexec ${quote(docker)} "$@"\n`, { mode: 0o700 });
    process.env.PATH = `${root}:${originalPath}`;
    await expect(database.cleanup()).rejects.toThrow("Disposable database cleanup failed");
    process.env.PATH = originalPath;
    for (const args of [["ps", "--all", "--quiet"], ["volume", "ls", "--quiet"]]) {
      const child = Bun.spawn([docker, ...args, "--filter", `label=fleur.issue25.database-owner=${owner}`], { stdout: "pipe", stderr: "ignore", timeout: 30000 });
      expect((await new Response(child.stdout).text()).trim()).toBe("");
      expect(await child.exited).toBe(0);
    }
  } finally { process.env.PATH = originalPath; await database.cleanup(); await rm(root, { recursive: true, force: true }); }
}, 90000);
