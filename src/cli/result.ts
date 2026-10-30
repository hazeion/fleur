export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;
export interface RecoveryAction { readonly command: string; readonly description: string }
export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly actions: readonly RecoveryAction[];
  readonly expected?: Json;
  readonly actual?: Json;
}
export interface CommandResult {
  readonly formatVersion: 1;
  readonly command: string;
  readonly ok: boolean;
  readonly data: Json;
  readonly error: CommandError | null;
  readonly truncated: boolean;
}
export interface CliOutcome { readonly human?: string; readonly streamed?: boolean; readonly exitCode: ExitCode; readonly result: CommandResult }
export function success(command: string, data: Json): CliOutcome {
  return { exitCode: 0, result: { formatVersion: 1, command, ok: true, data, error: null, truncated: false } };
}
export function failure(command: string, exitCode: Exclude<ExitCode, 0>, error: CommandError, data: Json = null): CliOutcome {
  return { exitCode, result: { formatVersion: 1, command, ok: false, data, error, truncated: false } };
}
