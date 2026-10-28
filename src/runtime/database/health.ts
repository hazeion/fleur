import type { MaintenanceConfiguration } from "./maintenance";
import { readMigrationStatus, type MigrationSummary } from "./migration-status";
import { DatabaseUnavailable, withInspection, type MaintenanceSummary, type TargetKind, type TargetSummary, type Unavailability } from "./target";

/** Stable readiness reason vocabulary, in reporting order. Each reason carries one structured action. */
export const readinessReasons = {
  DATABASE_UNAVAILABLE: { message: "The database could not be reached or refused the connection.", action: { command: "fleur status", description: "Start the PostgreSQL server or correct the private database configuration, then check status again." } },
  MIGRATION_PENDING: { message: "Committed migrations have not been applied to the database.", action: { command: "fleur db migration plan", description: "Review the pending migrations, then apply them explicitly with fleur db migration apply." } },
  SCHEMA_DRIFT: { message: "The database schema or migration history differs from Fleur's record.", action: { command: "fleur db migration status", description: "Inspect the reported differences. Never reset data or rewrite history to clear drift." } },
  MAINTENANCE_ACTIVE: { message: "A database maintenance operation is in progress.", action: { command: "fleur db recover --inspect", description: "Wait for the running maintenance operation to finish, then check status again." } },
  RECOVERY_REQUIRED: { message: "Interrupted database maintenance needs explicit recovery.", action: { command: "fleur db recover --inspect", description: "Inspect the recorded stage and retained backups, then follow the reviewed recovery procedure." } },
  PREREQUISITE_UNAVAILABLE: { message: "A local prerequisite for database inspection is unavailable, such as Fleur's private state directory.", action: { command: "fleur doctor", description: "Inspect local prerequisites; status does not run prerequisite probes." } },
} as const;
export type ReadinessReason = keyof typeof readinessReasons;

export type DatabaseHealth = {
  /** `unknown` when a local prerequisite stopped the probe before it could tell. */
  readonly connectivity: "connected" | "unreachable" | "unknown";
  readonly failure?: Unavailability;
  readonly target: TargetSummary;
  /** Maintenance or recovery stage from Fleur's control record, when the control database answered. */
  readonly maintenance: MaintenanceSummary | null;
  readonly migrations: MigrationSummary | null;
};
function maintenanceReasons(maintenance: MaintenanceSummary): ReadinessReason[] {
  return maintenance.state === "active" ? ["MAINTENANCE_ACTIVE"] : maintenance.state === "recovery required" ? ["RECOVERY_REQUIRED"] : [];
}
/**
 * The `status` database probe. Findings, including an unreachable database, are data. It reads only, and
 * `timeoutMs` bounds the whole probe.
 */
export async function databaseHealth(url: string, target: { readonly kind: TargetKind; readonly database: string }, project: string, config: MaintenanceConfiguration): Promise<{ readonly database: DatabaseHealth; readonly reasons: readonly ReadinessReason[] }> {
  const unknown = { kind: target.kind, database: target.database, serverVersion: null, fingerprint: null };
  try {
    const { target: summary, migrations } = await withInspection(url, target.kind, config, async session => ({ target: session.target, migrations: (await readMigrationStatus(session, project)).summary }));
    const reasons: ReadinessReason[] = [];
    if (migrations.pending.length) reasons.push("MIGRATION_PENDING");
    if (migrations.drift) reasons.push("SCHEMA_DRIFT");
    reasons.push(...maintenanceReasons(migrations.maintenance));
    return { database: { connectivity: "connected", target: summary, maintenance: migrations.maintenance, migrations }, reasons };
  } catch (error) {
    if (error instanceof DatabaseUnavailable) {
      // A target replaced or removed by maintenance is explained by that maintenance, not by a stopped server.
      const explained = error.maintenance ? maintenanceReasons(error.maintenance) : [];
      return { database: { connectivity: "unreachable", failure: error.failure, target: unknown, maintenance: error.maintenance, migrations: null }, reasons: explained.length ? explained : ["DATABASE_UNAVAILABLE"] };
    }
    // Unreadable or unsafe durable maintenance state is a finding: the server answered, but nothing can be read safely.
    if (error instanceof Error && error.message === "RECOVERY_REQUIRED") return { database: { connectivity: "connected", target: unknown, maintenance: null, migrations: null }, reasons: ["RECOVERY_REQUIRED"] };
    // A local prerequisite, such as an unusable private state directory, stopped the probe; doctor inspects those.
    if (error instanceof Error && error.message === "PREREQUISITE_UNAVAILABLE") return { database: { connectivity: "unknown", target: unknown, maintenance: null, migrations: null }, reasons: ["PREREQUISITE_UNAVAILABLE"] };
    throw error;
  }
}
