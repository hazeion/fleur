import type { MaintenanceConfiguration } from "./maintenance";
import { readMigrationStatus, type MigrationSummary } from "./migration-status";
import { DatabaseUnavailable, withInspection, type TargetKind, type TargetSummary, type Unavailability } from "./target";

/** Stable readiness reason vocabulary, in reporting order. Each reason carries one structured action. */
export const readinessReasons = {
  DATABASE_UNAVAILABLE: { message: "The database could not be reached or refused the connection.", action: { command: "fleur status", description: "Start the PostgreSQL server or correct the private database configuration, then check status again." } },
  MIGRATION_PENDING: { message: "Committed migrations have not been applied to the database.", action: { command: "fleur db migration plan", description: "Review the pending migrations, then apply them explicitly with fleur db migration apply." } },
  SCHEMA_DRIFT: { message: "The database schema or migration history differs from Fleur's record.", action: { command: "fleur db migration status", description: "Inspect the reported differences. Never reset data or rewrite history to clear drift." } },
  MAINTENANCE_ACTIVE: { message: "A database maintenance operation is in progress.", action: { command: "fleur db recover --inspect", description: "Wait for the running maintenance operation to finish, then check status again." } },
  RECOVERY_REQUIRED: { message: "Interrupted database maintenance needs explicit recovery.", action: { command: "fleur db recover --inspect", description: "Inspect the recorded stage and retained backups, then follow the reviewed recovery procedure." } },
  PREREQUISITE_UNAVAILABLE: { message: "A local prerequisite is unavailable.", action: { command: "fleur doctor", description: "Inspect local prerequisites; status does not run prerequisite probes." } },
} as const;
export type ReadinessReason = keyof typeof readinessReasons;

export type DatabaseHealth = {
  readonly connectivity: "connected" | "unreachable";
  readonly failure?: Unavailability;
  readonly target: TargetSummary;
  readonly migrations: MigrationSummary | null;
};
/**
 * The `status` database probe. Findings, including an unreachable database, are data. It reads only, and
 * `timeoutMs` bounds the whole probe.
 */
export async function databaseHealth(url: string, target: { readonly kind: TargetKind; readonly database: string }, project: string, config: MaintenanceConfiguration): Promise<{ readonly database: DatabaseHealth; readonly reasons: readonly ReadinessReason[] }> {
  const unknown = { kind: target.kind, database: target.database, serverVersion: null, fingerprint: null };
  try {
    const database = await withInspection(url, target.kind, config, async session => ({ connectivity: "connected" as const, target: session.target, migrations: (await readMigrationStatus(session, project)).summary }));
    const { pending, drift, maintenance } = database.migrations;
    const reasons: ReadinessReason[] = [];
    if (pending.length) reasons.push("MIGRATION_PENDING");
    if (drift) reasons.push("SCHEMA_DRIFT");
    if (maintenance.state === "active") reasons.push("MAINTENANCE_ACTIVE");
    if (maintenance.state === "recovery required") reasons.push("RECOVERY_REQUIRED");
    return { database, reasons };
  } catch (error) {
    if (error instanceof DatabaseUnavailable) return { database: { connectivity: "unreachable", failure: error.failure, target: unknown, migrations: null }, reasons: ["DATABASE_UNAVAILABLE"] };
    // A server that cannot answer the probe's statements in time is unreachable for this probe, too.
    if ((error as { errno?: unknown } | null)?.errno === "57014") return { database: { connectivity: "unreachable", failure: "timeout", target: unknown, migrations: null }, reasons: ["DATABASE_UNAVAILABLE"] };
    // Unreadable or unsafe durable maintenance state is a finding: the server answered, but nothing can be read safely.
    if (error instanceof Error && error.message === "RECOVERY_REQUIRED") return { database: { connectivity: "connected", target: unknown, migrations: null }, reasons: ["RECOVERY_REQUIRED"] };
    throw error;
  }
}
