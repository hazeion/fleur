import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { sweepLabelAtExit } from "./exit-sweep";

const image = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
const label = "fleur.issue25.database-owner";
async function docker(args: string[], timeout = 60_000): Promise<string> {
  const child = Bun.spawn([Bun.which("docker", { PATH: process.env.PATH ?? "" }) ?? "docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeout);
  const [output, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error("Owned PostgreSQL Docker operation failed");
  return output.trim();
}
export async function ownedPostgres(options: { disk?: boolean } = {}) {
  const owner = randomUUID().replaceAll("-", "");
  const name = `fleur-read-${owner}`;
  const database = `fleur_read_${owner}`;
  const password = randomUUID();
  let id: string | undefined;
  let volume: string | undefined;
  let sql: SQL | undefined;
  const pausedListeners = new Set<number>();
  const releaseSweep = sweepLabelAtExit(`${label}=${owner}`);
  async function cleanup() {
    const errors: unknown[] = [];
    for (const pid of pausedListeners) try { await docker(["exec", id!, "kill", "-CONT", String(pid)]); } catch (error) { errors.push(error); }
    pausedListeners.clear();
    if (sql) try { await sql.close({ timeout: 0 }); } catch (error) { errors.push(error); }
    if (id) try {
      const metadata = JSON.parse(await docker(["inspect", id])) as { Id: string; Config: { Labels: Record<string, string> } }[];
      if (metadata[0]?.Id !== id || metadata[0].Config.Labels[label] !== owner) throw new Error("Disposable database ownership changed");
      await docker(["rm", "--force", id]);
      const remaining = await docker(["ps", "--all", "--quiet", "--filter", `label=${label}=${owner}`]);
      if (remaining !== "") throw new Error("Disposable database cleanup incomplete");
      id = undefined;
    } catch (error) { errors.push(error); }
    if (volume) try {
      const metadata = JSON.parse(await docker(["volume", "inspect", volume])) as { Name: string; Labels: Record<string, string> }[];
      if (metadata[0]?.Name !== volume || metadata[0].Labels[label] !== owner) throw new Error("Disposable volume ownership changed");
      await docker(["volume", "rm", volume]);
      volume = undefined;
    } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Disposable database cleanup failed");
    releaseSweep();
  }
  try {
    // The digest pin is the identity: reuse it when already present, pull only when absent.
    const present = await docker(["image", "inspect", "--format", "{{.Id}}", image]).then(() => true, () => false);
    if (!present) await docker(["pull", image], 180_000);
    if (options.disk) {
      volume = await docker(["volume", "create", "--label", `${label}=${owner}`, `${name}-data`]);
      if (volume !== `${name}-data`) throw new Error("Missing owned benchmark volume identity");
    }
    const storage = volume ? ["--mount", `type=volume,src=${volume},dst=/var/lib/postgresql`] : ["--tmpfs", "/var/lib/postgresql:rw,size=384m"];
    id = await docker(["run", "--detach", "--name", name, "--label", `${label}=${owner}`, "--cpus", "1", "--memory", "512m", "--pids-limit", "64", ...storage, "--publish", "127.0.0.1::5432", "--env", `POSTGRES_USER=${database}`, "--env", `POSTGRES_DB=${database}`, "--env", `POSTGRES_PASSWORD=${password}`, image]);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Missing owned container identity");
    const metadata = JSON.parse(await docker(["inspect", id])) as { Mounts: { Type: string; Destination: string; Name?: string }[]; HostConfig: { Tmpfs?: Record<string, string> }; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } }[];
    const container = metadata[0]!;
    if (volume) {
      if (container.Mounts.length !== 1 || container.Mounts[0]?.Type !== "volume" || container.Mounts[0]?.Name !== volume || container.Mounts[0]?.Destination !== "/var/lib/postgresql") throw new Error("Unexpected database mount");
    } else if (container.Mounts.length !== 0 || Object.keys(container.HostConfig.Tmpfs ?? {}).length !== 1 || container.HostConfig.Tmpfs?.["/var/lib/postgresql"] !== "rw,size=384m") throw new Error("Unexpected tmpfs database mount");
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
      for (const tool of ["pg_dump", "pg_restore", "psql"]) await writeFile(`${directory}/${tool}`, `#!/bin/sh\nexec docker exec -i --env PGPASSWORD --env PGUSER --env PGDATABASE --env PGAPPNAME --env PGOPTIONS --env PGCONNECT_TIMEOUT --env PGHOST=127.0.0.1 --env PGPORT=5432 ${id} ${tool} "$@"\n`, { mode: 0o700 });
      return directory;
    }
    const declared=new Map<string,import("../../src/database").Table>();
    /** Trusted fixture setup for manually authored broker/isolation SQL. This is not migration-application evidence. */
    async function reviewSchema(tables:readonly import("../../src/database").Table[]) {
      const {tableDefinitions}=await import("../../src/runtime/declarations");
      const {migrationPlan}=await import("../../src/runtime/database/migration-plan");
      const {catalogFingerprint}=await import("../../src/runtime/database/migration-state");
      for(const table of tables)declared.set(tableDefinitions.get(table)!.name,table);
      const plan=migrationPlan([...declared.values()]);
      await sql!.unsafe("CREATE SCHEMA IF NOT EXISTS fleur_internal; CREATE TABLE IF NOT EXISTS fleur_internal.migrations(position integer PRIMARY KEY,id text NOT NULL UNIQUE,checksum text NOT NULL UNIQUE,parent_checksum text,catalog text NOT NULL,snapshot text NOT NULL)");
      const connection=await sql!.reserve();
      let catalog:string;
      try{catalog=await catalogFingerprint(connection);}finally{connection.release();}
      await sql!.unsafe("DELETE FROM fleur_internal.migrations");
      await sql!.unsafe("INSERT INTO fleur_internal.migrations VALUES(1,$1,$2,NULL,$3,$4)",[plan.id,plan.checksum,catalog,JSON.stringify(plan.snapshot)]);
    }
    async function reviewApplication(images:import("../../src/runtime/native/endpoint").NativeImages,create=false) {
      const {startWorker}=await import("../../src/runtime/native/host");
      const {restoreManifest}=await import("../../src/runtime/manifest-wire");
      const worker=await startWorker(images),session=crypto.randomUUID();
      try {
        const result=await worker.run({mode:"register",session},()=>{throw new Error("Unexpected fixture dispatch");});
        if(!result||typeof result!=="object"||!("value" in result))throw new Error("Invalid fixture registration");
        const tables=restoreManifest(result.value).tables;
        if(create){const {tableDDL}=await import("../../src/runtime/database/table-ddl");for(const statement of tableDDL(tables))await sql!.unsafe(statement);}
        await reviewSchema(tables);
      }finally{await worker.close();}
    }
    /**
     * Restarts the PostgreSQL server through crash recovery. A SIGKILLed backend makes the postmaster terminate every
     * session, reinitialize and replay WAL from the container's storage, which outlives the server processes.
     */
    async function restart() {
      const victim = new SQL(url, { max: 1, connectionTimeout: 2 });
      try {
        const pid = Number((await victim`SELECT pg_backend_pid() AS pid`)[0]?.pid);
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid backend process");
        await docker(["exec", id!, "sh", "-c", `kill -9 ${pid}`]);
      } finally { await victim.close({ timeout: 0 }).catch(() => {}); }
      const deadline = Date.now() + 30_000;
      for (;;) {
        // Both pooled connections were terminated; exercise each before handing the pool back.
        try { await Promise.all([sql!`SELECT 1`, sql!`SELECT 1`]); return; }
        catch {
          if (Date.now() >= deadline) throw new Error("Owned database did not recover after restart");
          await Bun.sleep(100);
        }
      }
    }
    async function pauseNotifications() {
      const rows = await sql!`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() AND query ~* '^LISTEN[[:space:]]+"?fleur_revision"?;?$'`;
      if (rows.length !== 1) throw new Error("Expected one owned Fleur notification listener");
      const pid = Number(rows[0].pid);
      if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid owned listener process");
      await docker(["exec", id!, "kill", "-STOP", String(pid)]);
      pausedListeners.add(pid);
      return async () => { if (pausedListeners.has(pid)) { await docker(["exec", id!, "kill", "-CONT", String(pid)]); pausedListeners.delete(pid); } };
    }
    async function storageDevice() {
      if (!volume || !id) throw new Error("Reference storage requires the owned disk volume");
      const metadata = JSON.parse(await docker(["inspect", id])) as { Config: { Labels: Record<string, string> }; Mounts: { Type: string; Name?: string; Destination: string }[] }[];
      if (metadata[0]?.Config.Labels[label] !== owner || metadata[0].Mounts.length !== 1 || metadata[0].Mounts[0]?.Type !== "volume" || metadata[0].Mounts[0]?.Name !== volume || metadata[0].Mounts[0]?.Destination !== "/var/lib/postgresql") throw new Error("Reference volume ownership changed");
      const device = await docker(["exec", id, "stat", "--format=%Hd:%Ld", "/var/lib/postgresql"]);
      if (!/^[0-9]{1,10}:[0-9]{1,10}$/.test(device)) throw new Error("Reference volume device is unavailable");
      return device;
    }
    return { sql, url, image, storage: volume ? "volume" : "tmpfs", cleanup, pgTools, reviewSchema, reviewApplication, restart, pauseNotifications, storageDevice };
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Disposable database setup and cleanup failed"); }
    throw error;
  }
}
