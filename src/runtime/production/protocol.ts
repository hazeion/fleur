/** One line per event from the artifact supervisor to its launcher, on a private pipe. */
export type SupervisorEvent =
  | { readonly event: "ready"; readonly url: string; readonly artifact: string }
  | { readonly event: "failed"; readonly code: string }
  | { readonly event: "stopped" };
export const startFailures: Readonly<Record<string, { readonly exit: 1 | 3 | 4 | 5; readonly message: string; readonly command: string; readonly description: string }>> = {
  ARTIFACT_INVALID: { exit: 4, message: "The artifact is missing, corrupt or incomplete; nothing from it ran.", command: "fleur build", description: "Build or copy a complete artifact, then start it." },
  ARTIFACT_INCOMPATIBLE: { exit: 4, message: "The artifact was built for a different Fleur release, Bun version or architecture.", command: "fleur build", description: "Build an artifact with this release on the target architecture." },
  CONFIGURATION_MISSING: { exit: 4, message: "Required private production configuration or a declared broker secret is missing.", command: "fleur status --production", description: "Supply the private database configuration and declared credentials through the startup environment." },
  DATABASE_UNAVAILABLE: { exit: 4, message: "The configured production database could not be reached.", command: "fleur status --production", description: "Start the PostgreSQL server or correct the private database configuration." },
  DATABASE_PRIVILEGE_INSUFFICIENT: { exit: 4, message: "The configured credential lacks authority this application needs.", command: "fleur status --production", description: "Grant the minimum-privilege profile in the package docs/maintenance.md." },
  MIGRATIONS_PENDING: { exit: 5, message: "Reviewed migrations must be applied before this artifact can serve. Start never applies them.", command: "fleur db migration plan", description: "Review the pending migrations, then apply them explicitly." },
  SCHEMA_DRIFT: { exit: 5, message: "The database differs from this artifact's recorded schema.", command: "fleur db migration status --production", description: "Inspect the reported differences. Never reset data or rewrite history." },
  MAINTENANCE_BUSY: { exit: 5, message: "Database maintenance is in progress.", command: "fleur db recover --inspect", description: "Wait for the running maintenance operation to finish, then start again." },
  RECOVERY_REQUIRED: { exit: 5, message: "Interrupted maintenance or execution ownership needs explicit inspection.", command: "fleur db recover --inspect", description: "Inspect the recorded stage and retained evidence before retrying." },
  PORT_OCCUPIED: { exit: 4, message: "The configured port is in use. Production never selects another port.", command: "fleur start --help", description: "Free the port or explicitly choose another with --port." },
  ALREADY_RUNNING: { exit: 4, message: "This application already has a production start on this machine.", command: "fleur status --production", description: "Stop the running start before starting it again." },
  READINESS_TIMEOUT: { exit: 4, message: "Startup exceeded its readiness deadline. Importing a new image can need a longer --timeout.", command: "fleur doctor", description: "Recheck prerequisites, then retry with a longer --timeout." },
  PREREQUISITE_UNAVAILABLE: { exit: 4, message: "Docker readiness did not admit this runtime.", command: "fleur doctor", description: "Inspect the exact prerequisite action before starting." },
  AUTHORITY_REQUIRED: { exit: 3, message: "A prerequisite needs explicit human authority.", command: "fleur setup", description: "Inspect the exact proposed action." },
  HUMAN_ACTION_REQUIRED: { exit: 3, message: "A prerequisite needs manual action.", command: "fleur setup", description: "Complete the documented manual action." },
  SOURCE_REJECTED: { exit: 1, message: "The artifact's application did not register or render as built.", command: "fleur build", description: "Build the artifact again and inspect the application." },
  EXECUTION_RECOVERY_REQUIRED: { exit: 5, message: "Owned execution containers could not be confirmed retired.", command: "fleur doctor", description: "Inspect owned containers before retrying." },
  INSTANCE_UNAVAILABLE: { exit: 1, message: "The application transport failed. Restart explicitly after inspecting stderr.", command: "fleur start --help", description: "Restart explicitly; there is no automatic restart." },
  INTERNAL_FAILURE: { exit: 1, message: "Startup failed unexpectedly; no secret was printed.", command: "fleur doctor", description: "Inspect prerequisites and retry." },
};
