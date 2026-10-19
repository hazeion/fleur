import { nativeInstallProfiles, type NativeInstallProfile } from "./native.ts";
import { doctor } from "./doctor.ts";
import { listGrants, revokeGrant } from "./grants.ts";
import { setup } from "./setup.ts";
import { productionHost } from "./host.ts";
import type { CommandDefinition } from "../cli/catalog.ts";
export interface HostIdentity {
  readonly system: string;
  readonly architecture: string;
  readonly translated: boolean | null;
  readonly release: string;
  readonly distribution?: string;
  readonly machineId?: string;
}
export interface HostCommandResult {
  readonly status: "completed" | "missing" | "timeout";
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
}
export interface SetupHost {
  readonly host: () => Promise<HostIdentity>;
  readonly stateDirectory?: string;
  /** Private host filesystem boundary; production always uses /Applications. */
  readonly desktopApplicationsDirectory?: string;
  readonly interactive?: boolean;
  /** External filesystem durability boundary; production opens and fsyncs the directory. */
  readonly syncDirectory?: (directory: string) => Promise<void>;
  readonly confirmHuman?: (plan: { readonly action: string; readonly method: string; readonly target: string; readonly checksum: string }, timeoutMs: number) => Promise<"once" | "remembered" | "deny">;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly run: (args: readonly string[], timeoutMs: number) => Promise<HostCommandResult>;
}
export function setupCommands(host: SetupHost = productionHost(), profiles: readonly NativeInstallProfile[] = nativeInstallProfiles): readonly CommandDefinition[] {
  return [
    { name: "setup grants revoke", usage: "setup grants revoke <id>", summary: "Revoke a setup grant without changing installed software.", run: (input) => revokeGrant(input, host) },
    { name: "setup grants list", usage: "setup grants list", summary: "Inspect this OS user's setup grants.", run: (input) => listGrants(input, host) },
    { name: "setup", usage: "setup [--grant <id>]", summary: "Inspect authorized resumable prerequisite setup actions.", options: [{ name: "--grant", value: true }], run: (input) => setup(input, host, profiles) },
    { name: "doctor", usage: "doctor", summary: "Inspect local prerequisites without installing software.", run: (input) => doctor(input, host) },
  ];
}
