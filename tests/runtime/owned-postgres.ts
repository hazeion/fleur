import { SQL } from "bun";
import { randomUUID } from "node:crypto";

const image = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
const label = "fleur.issue25.database-owner";
async function docker(args: string[], timeout = 60_000): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error("Owned PostgreSQL Docker operation failed");
  return output.trim();
}
export async function ownedPostgres() {
  const owner = randomUUID().replaceAll("-", "");
  const name = `fleur-read-${owner}`;
  const database = `fleur_read_${owner}`;
  const password = randomUUID();
  let id: string | undefined;
  let sql: SQL | undefined;
  async function cleanup() {
    if (sql) await sql.close({ timeout: 0 });
    if (!id) return;
    const metadata = JSON.parse(await docker(["inspect", id])) as { Id: string; Config: { Labels: Record<string, string> } }[];
    if (metadata[0]?.Id !== id || metadata[0].Config.Labels[label] !== owner) throw new Error("Disposable database ownership changed");
    await docker(["rm", "--force", id]);
    const remaining = await docker(["ps", "--all", "--quiet", "--filter", `label=${label}=${owner}`]);
    if (remaining !== "") throw new Error("Disposable database cleanup incomplete");
    id = undefined;
  }
  try {
    await docker(["pull", image], 180_000);
    id = await docker(["run", "--detach", "--name", name, "--label", `${label}=${owner}`, "--cpus", "1", "--memory", "512m", "--pids-limit", "64", "--tmpfs", "/var/lib/postgresql:rw,size=384m", "--publish", "127.0.0.1::5432", "--env", `POSTGRES_USER=${database}`, "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_PASSWORD=${password}`, image]);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Missing owned container identity");
    const metadata = JSON.parse(await docker(["inspect", id])) as { Mounts: { Type: string; Destination: string }[]; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } }[];
    const container = metadata[0]!;
    if (container.Mounts.some(mount => mount.Type !== "tmpfs" || mount.Destination !== "/var/lib/postgresql")) throw new Error("Unexpected database mount");
    const ports = container.NetworkSettings.Ports["5432/tcp"];
    if (ports?.length !== 1 || ports[0]?.HostIp !== "127.0.0.1") throw new Error("Database endpoint is not owned loopback");
    const url = `postgres://${database}:${password}@127.0.0.1:${ports[0].HostPort}/${database}`;
    sql = new SQL(url, { max: 2, connectionTimeout: 2 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const rows = await sql`SELECT current_database() AS name, current_setting('server_version_num') AS version`;
        if (rows[0]?.name !== database || rows[0]?.version !== "180006") throw new Error("Unexpected owned database identity");
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("Owned database readiness failed");
        await Bun.sleep(100);
      }
    }
    async function pgTools(directory: string) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const tool of ["pg_dump", "pg_restore", "psql"]) await writeFile(`${directory}/${tool}`, `#!/bin/sh\nexec docker exec -i --env PGPASSWORD --env PGUSER --env PGDATABASE --env PGHOST=127.0.0.1 --env PGPORT=5432 ${id} ${tool} "$@"\n`, { mode: 0o700 });
      return directory;
    }
    return { sql, url, cleanup, pgTools };
  } catch (error) { await cleanup(); throw error; }
}
