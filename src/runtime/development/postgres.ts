import { SQL } from "bun";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { MaintenanceLease, privateDirectory } from "../database/maintenance";
import { join } from "node:path";
import { nativeCommand } from "../native/command";
import { selectedEndpoint } from "../native/endpoint";
import { privateJson } from "../database/maintenance-authority";
import { save, type Binding } from "./state";

const image = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
export const databaseLabel = "dev.fleur.development-binding";
const schema = z.strictObject({ formatVersion: z.literal(1), binding: z.string(), endpoint: z.string(), container: z.string().regex(/^[a-f0-9]{64}$/).nullable(), password: z.string().uuid(), volume: z.string(), stage: z.enum(["creating", "owned"]), cluster: z.string().nullable() });
type Record = z.infer<typeof schema>;
export class DevelopmentPostgres {
  readonly #bound: Binding;
  readonly #record: Record;
  private constructor(bound: Binding, record: Record) { this.#bound = bound; this.#record = record; }
  #command(args: string[], timeout = 5000) { return nativeCommand(["docker", "--host", this.#record.endpoint, ...args], timeout); }
  static async read(bound: Binding): Promise<DevelopmentPostgres | null> {
    try {
      const record = schema.parse(await privateJson(join(bound.directory, "postgres.json")));
      if (record.binding !== bound.id || record.volume !== `fleur-dev-${bound.id}` || record.endpoint !== await selectedEndpoint()) throw new Error("RECOVERY_REQUIRED");
      return new DevelopmentPostgres(bound, record);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("RECOVERY_REQUIRED"); }
  }
  static async start(bound: Binding, deadline: number): Promise<DevelopmentPostgres> {
    let resource = await DevelopmentPostgres.read(bound);
    if (!resource) {
      const endpoint = await selectedEndpoint(), volume = `fleur-dev-${bound.id}`;
      const command = (args: string[]) => nativeCommand(["docker", "--host", endpoint, ...args]);
      // Unknown same-name resources cannot be adopted, even if stopped.
      if (await command(["ps", "--all", "--quiet", "--filter", `name=^/${volume}$`]) || await command(["volume", "ls", "--quiet", "--filter", `name=^${volume}$`])) throw new Error("RECOVERY_REQUIRED");
      resource = new DevelopmentPostgres(bound, { formatVersion: 1, binding: bound.id, endpoint, container: null, password: crypto.randomUUID(), volume, stage: "creating", cluster: null });
      await resource.#persist();
      await command(["volume", "create", "--label", `${databaseLabel}=${bound.id}`, volume]);
      const present = await command(["image", "inspect", "--format", "{{.Id}}", image]).then(() => true, () => false);
      if (!present) throw new Error("PREREQUISITE_UNAVAILABLE");
      const container = await command(["create", "--name", volume, "--label", `${databaseLabel}=${bound.id}`, "--cpus", "1", "--memory", "512m", "--pids-limit", "64", "--mount", `type=volume,source=${volume},target=/var/lib/postgresql`, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=fleur", "--env", "POSTGRES_DB=postgres", "--env", `POSTGRES_PASSWORD=${resource.#record.password}`, image]);
      if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("RECOVERY_REQUIRED");
      resource.#record.container = container; resource.#record.stage = "owned";
      await resource.#persist();
    }
    const metadata = await resource.#inspect();
    if (!metadata.State.Running) await resource.#command(["start", metadata.Id]);
    for (;;) {
      const url = await resource.url("postgres"), sql = new SQL(url, { max: 1, connectionTimeout: 1 });
      try {
        const row = (await sql.unsafe("SELECT system_identifier::text AS cluster FROM pg_control_system()"))[0];
        if (!row || resource.#record.cluster !== null && resource.#record.cluster !== row.cluster) throw new Error("RECOVERY_REQUIRED");
        resource.#record.cluster = row.cluster; await resource.#persist(); return resource;
      } catch (error) {
        if (error instanceof Error && error.message === "RECOVERY_REQUIRED") throw error;
        if (performance.now() >= deadline) throw new Error("READINESS_TIMEOUT");
        await Bun.sleep(100);
      } finally { await sql.close({ timeout: 0 }); }
    }
  }
  #persist() { return save(this.#bound.directory, "postgres.json", this.#record); }
  async #inspect() {
    const { container, volume, binding } = this.#record;
    if (!container || this.#record.stage !== "owned") throw new Error("RECOVERY_REQUIRED");
    const metadata = JSON.parse(await this.#command(["inspect", container, "--format", "{{json .}}"]));
    const stored = JSON.parse(await this.#command(["volume", "inspect", volume, "--format", "{{json .}}"]));
    const expectedImage = await this.#command(["image", "inspect", image, "--format", "{{.Id}}"]);
    if (metadata.Id !== container || metadata.Name !== "/"+volume || metadata.Image !== expectedImage || metadata.Config.Labels?.[databaseLabel] !== binding || stored.Name !== volume || stored.Labels?.[databaseLabel] !== binding
      || metadata.Mounts.length !== 1 || metadata.Mounts[0].Type !== "volume" || metadata.Mounts[0].Name !== volume || metadata.Mounts[0].Destination !== "/var/lib/postgresql") throw new Error("RECOVERY_REQUIRED");
    const bindingPorts = metadata.HostConfig.PortBindings?.["5432/tcp"];
    if (bindingPorts?.length !== 1 || bindingPorts[0].HostIp !== "127.0.0.1") throw new Error("RECOVERY_REQUIRED");
    return metadata as { Id: string; State: { Running: boolean }; NetworkSettings: { Ports: { "5432/tcp": { HostIp: string; HostPort: string }[] | null } } };
  }
  async url(database = "application"): Promise<string> {
    const metadata = await this.#inspect(), ports = metadata.NetworkSettings.Ports["5432/tcp"];
    if (!metadata.State.Running || ports?.length !== 1 || ports[0]?.HostIp !== "127.0.0.1" || !/^\d+$/.test(ports[0].HostPort)) throw new Error("DATABASE_UNAVAILABLE");
    return `postgres://fleur:${this.#record.password}@127.0.0.1:${ports[0].HostPort}/${database}`;
  }
  async tools(): Promise<string> {
    const metadata = await this.#inspect(), directory = join(this.#bound.directory, "pg-tools");
    await privateDirectory(directory);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const tool of ["pg_dump", "pg_restore", "psql"]) {
      const script = `#!/bin/sh\nexec docker --host ${quote(this.#record.endpoint)} exec -i --env PGPASSWORD --env PGUSER --env PGDATABASE --env PGHOST=127.0.0.1 --env PGPORT=5432 ${quote(metadata.Id)} ${tool} "$@"\n`;
      await writeFile(join(directory, tool), script, { mode: 0o700 });
    }
    return directory;
  }
  async stop(timeoutMs = 30000): Promise<void> {
    const metadata = await this.#inspect();
    if (!metadata.State.Running) return;
    // Inspect admission also works before the application database exists. It
    // holds the same shared fence as brokers, so held/queued maintenance wins.
    const admission = await MaintenanceLease.acquire(await this.url(), false, { stateRoot: join(this.#bound.directory, "maintenance"), timeoutMs, controlUrl: await this.url("postgres") }, true);
    try {
      if (admission.busy) throw new Error("MAINTENANCE_BUSY");
      const marker = await admission.marker();
      if (marker && !["committed", "rollback verified"].includes(marker.stage)) throw new Error("RECOVERY_REQUIRED");
      await admission.assertSession();
      await this.#command(["stop", "--time", "5", metadata.Id], 10000);
      if ((await this.#inspect()).State.Running) throw new Error("RECOVERY_REQUIRED");
    } finally { await admission.close(); }
  }
}
