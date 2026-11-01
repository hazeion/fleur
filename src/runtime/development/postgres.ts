import { SQL } from "bun";
import { z } from "zod";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { MaintenanceLease, privateDirectory, syncDirectory } from "../database/maintenance";
import { dirname, join } from "node:path";
import { nativeCommand } from "../native/command";
import { selectedEndpoint } from "../native/endpoint";
import { privateJson } from "../database/maintenance-authority";
import { save, type Binding } from "./state";

/** Digest-pinned multi-architecture PostgreSQL image; development startup requires it to be present locally. */
export const developmentPostgresImage = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
const image = developmentPostgresImage;
export const databaseLabel = "dev.fleur.development-binding";
const schema = z.strictObject({ formatVersion: z.literal(1), binding: z.string(), endpoint: z.string(), container: z.string().regex(/^[a-f0-9]{64}$/).nullable(), password: z.string().uuid(), volume: z.string(), stage: z.enum(["creating", "owned"]), cluster: z.string().nullable(), queryPassword: z.string().uuid().optional(), applicationOid: z.string().regex(/^\d+$/).optional() });
type PostgresRecord = z.infer<typeof schema>;
/** Private handoffs and generated tools never follow or overwrite foreign files. */
async function verifyPrivateFile(path: string, contents: string, mode: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(), expected = Buffer.from(contents);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== mode || info.size !== expected.length || expected.length > 16384) throw new Error("RECOVERY_REQUIRED");
    const bytes = Buffer.alloc(expected.length + 1); let used = 0;
    while (used < bytes.length) { const read = await file.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    const current = await lstat(path);
    if (used !== expected.length || !bytes.subarray(0, used).equals(expected) || current.isSymbolicLink() || current.ino !== info.ino || current.dev !== info.dev) throw new Error("RECOVERY_REQUIRED");
    return info;
  } finally { await file.close(); }
}
async function publishPrivateFile(path: string, contents: string, mode: number): Promise<void> {
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      await verifyPrivateFile(path, contents, mode); return null;
    });
    if (!file) return;
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    await verifyPrivateFile(path, contents, mode); await syncDirectory(dirname(path));
  } catch { throw new Error("RECOVERY_REQUIRED"); }
}
export class DevelopmentPostgres {
  readonly #bound: Binding;
  readonly #record: PostgresRecord;
  private constructor(bound: Binding, record: PostgresRecord) { this.#bound = bound; this.#record = record; }
  #command(args: string[], timeout = 5000) { return nativeCommand(["docker", "--host", this.#record.endpoint, ...args], timeout); }
  static async read(bound: Binding): Promise<DevelopmentPostgres | null> {
    try {
      const record = schema.parse(await privateJson(join(bound.directory, "postgres.json")));
      if (record.binding !== bound.id || record.volume !== `fleur-dev-${bound.id}` || record.endpoint !== await selectedEndpoint()) throw new Error("RECOVERY_REQUIRED");
      return new DevelopmentPostgres(bound, record);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("RECOVERY_REQUIRED"); }
  }
  static async start(bound: Binding, deadline: number, checkOpen: () => void = () => {}): Promise<DevelopmentPostgres> {
    checkOpen();
    let resource = await DevelopmentPostgres.read(bound);
    if (!resource) {
      const endpoint = await selectedEndpoint(), volume = `fleur-dev-${bound.id}`;
      const command = (args: string[]) => nativeCommand(["docker", "--host", endpoint, ...args]);
      // Unknown same-name resources cannot be adopted, even if stopped.
      if (await command(["ps", "--all", "--quiet", "--filter", `name=^/${volume}$`]) || await command(["volume", "ls", "--quiet", "--filter", `name=^${volume}$`])) throw new Error("RECOVERY_REQUIRED");
      const present = await command(["image", "inspect", "--format", "{{.Id}}", image]).then(id => /^sha256:[a-f0-9]{64}$/.test(id), () => false);
      if (!present) throw new Error("PREREQUISITE_UNAVAILABLE");
      resource = new DevelopmentPostgres(bound, { formatVersion: 1, binding: bound.id, endpoint, container: null, password: crypto.randomUUID(), volume, stage: "creating", cluster: null });
      checkOpen(); await resource.#persist();
      checkOpen(); await command(["volume", "create", "--label", `${databaseLabel}=${bound.id}`, volume]);
      checkOpen(); await publishPrivateFile(join(bound.directory, "postgres.env"), resource.#handoff(), 0o600);
      checkOpen(); const container = await command(["create", "--name", volume, "--label", `${databaseLabel}=${bound.id}`, "--cpus", "1", "--memory", "512m", "--pids-limit", "64", "--mount", `type=volume,source=${volume},target=/var/lib/postgresql`, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=fleur", "--env", "POSTGRES_DB=postgres", "--env-file", join(bound.directory, "postgres.env"), image]);
      if (!/^[a-f0-9]{64}$/.test(container)) throw new Error("RECOVERY_REQUIRED");
      resource.#record.container = container; resource.#record.stage = "owned";
      await resource.#persist();
    }
    const metadata = await resource.#inspect();
    await resource.#retireHandoff();
    checkOpen();
    if (!metadata.State.Running) await resource.#command(["start", metadata.Id]);
    for (;;) {
      checkOpen();
      const url = await resource.url("postgres"), sql = new SQL(url, { max: 1, connectionTimeout: 1 });
      try {
        const row = (await sql.unsafe("SELECT system_identifier::text AS cluster FROM pg_control_system()"))[0];
        if (!row || resource.#record.cluster !== null && resource.#record.cluster !== row.cluster) throw new Error("RECOVERY_REQUIRED");
        resource.#record.cluster = row.cluster;
        const queryPassword = crypto.randomUUID();
        const { provisionAgentQueryRole } = await import("../database/agent-query-role");
        await provisionAgentQueryRole(sql, queryPassword);
        resource.#record.queryPassword = queryPassword;
        await resource.#persist(); return resource;
      } catch (error) {
        if (error instanceof Error && error.message === "RECOVERY_REQUIRED") throw error;
        if (performance.now() >= deadline) throw new Error("READINESS_TIMEOUT");
        await Bun.sleep(100);
      } finally { await sql.close({ timeout: 0 }); }
    }
  }
  #persist() { return save(this.#bound.directory, "postgres.json", this.#record); }
  #handoff() { return `POSTGRES_PASSWORD=${this.#record.password}\n`; }
  async #retireHandoff(): Promise<void> {
    const path = join(this.#bound.directory, "postgres.env");
    try {
      const verified = await verifyPrivateFile(path, this.#handoff(), 0o600), current = await lstat(path);
      if (current.isSymbolicLink() || current.ino !== verified.ino || current.dev !== verified.dev) throw new Error("RECOVERY_REQUIRED");
      await unlink(path); await syncDirectory(this.#bound.directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("RECOVERY_REQUIRED"); }
  }
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
  /** Startup records application identity after creation or approved replacement, without claiming readiness. */
  async bindApplication(config: import("../database/maintenance").MaintenanceConfiguration): Promise<void> {
    const url = await this.url(), lease = await MaintenanceLease.acquire(url, false, config, true);
    try {
      if (lease.target.cluster !== this.#record.cluster || lease.target.database !== "application" || lease.target.oid === "0") throw new Error("DATABASE_UNAVAILABLE");
      const marker = await lease.marker();
      if (this.#record.applicationOid && this.#record.applicationOid !== lease.target.oid && (marker?.stage !== "committed" || marker.target.oid !== lease.target.oid || marker.target.cluster !== lease.target.cluster)) throw new Error("DATABASE_UNAVAILABLE");
      this.#record.applicationOid = lease.target.oid;
      await this.#persist();
    } finally { await lease.close(); }
  }
  /** No configuration URL can select this operation's target. Verify the stored cluster and database OID first. */
  async query(project: string, options: import("../database/query").QueryOptions, config: import("../database/maintenance").MaintenanceConfiguration) {
    let url: string, controlUrl: string;
    try { url = await this.url(); controlUrl = await this.url("postgres"); }
    catch { throw new Error("DATABASE_UNAVAILABLE"); }
    if (!this.#record.cluster || !this.#record.queryPassword || !this.#record.applicationOid) throw new Error("DATABASE_UNAVAILABLE");
    const lease = await MaintenanceLease.acquire(url, false, { ...config, controlUrl }, true);
    let sql: SQL | undefined;
    try {
      const marker = await lease.marker();
      if (lease.busy || marker && !["committed", "rollback verified"].includes(marker.stage)) throw new Error("MAINTENANCE_BUSY");
      if (lease.target.cluster !== this.#record.cluster || lease.target.database !== "application" || lease.target.oid === "0") throw new Error("DATABASE_UNAVAILABLE");
      if (lease.target.oid !== this.#record.applicationOid && (marker?.stage !== "committed" || marker.target.oid !== lease.target.oid || marker.target.cluster !== this.#record.cluster)) throw new Error("DATABASE_UNAVAILABLE");
      sql = new SQL(url, { max: 1, connectionTimeout: 2 });
      const identity = (await sql.unsafe("SELECT system_identifier::text AS cluster,current_database() AS database,d.oid::text AS oid FROM pg_control_system(),pg_database d WHERE datname=current_database()"))[0];
      if (identity?.cluster !== lease.target.cluster || identity.database !== lease.target.database || identity.oid !== lease.target.oid) throw new Error("DATABASE_UNAVAILABLE");
      const { queryDevelopmentDatabase } = await import("../database/query");
      return await queryDevelopmentDatabase(url, this.#record.queryPassword, project, options, { ...config, controlUrl });
    } catch (error) {
      const { unavailability } = await import("../database/target");
      if (unavailability(error)) throw new Error("DATABASE_UNAVAILABLE");
      throw error;
    } finally { await sql?.close({ timeout: 0 }); await lease.close(); }
  }

  async tools(): Promise<string> {
    const metadata = await this.#inspect(), directory = join(this.#bound.directory, "pg-tools-v2");
    await privateDirectory(directory);
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    for (const tool of ["pg_dump", "pg_restore", "psql"]) {
      const script = `#!/bin/sh\nexec docker --host ${quote(this.#record.endpoint)} exec -i --env PGPASSWORD --env PGUSER --env PGDATABASE --env PGAPPNAME --env PGOPTIONS --env PGCONNECT_TIMEOUT --env PGHOST=127.0.0.1 --env PGPORT=5432 ${quote(metadata.Id)} ${tool} "$@"\n`;
      await publishPrivateFile(join(directory, tool), script, 0o700);
    }
    return directory;
  }
  async stop(timeoutMs = 30000): Promise<void> {
    const metadata = await this.#inspect();
    await this.#retireHandoff();
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
