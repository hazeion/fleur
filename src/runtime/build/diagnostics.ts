import { failure } from "../../cli/result";

export interface SourceDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly code: string;
  readonly action: string;
}

/** Never include application source, absolute paths or resolver/bundler messages. */
export class SourceAdmissionError extends Error {
  readonly diagnostic: SourceDiagnostic;
  constructor(file: string, line: number, code: string, action: string) {
    super("SOURCE_REJECTED");
    this.name = "SourceAdmissionError";
    this.diagnostic = Object.freeze({
      file: /^(?:(?:client|server|shared|seeds|assets)\/[a-zA-Z0-9_./-]{1,200}|tsconfig\.json)$/.test(file) && !file.split("/").includes("..") ? file : "application source",
      line, code, action,
    });
  }
}
export function sourceFailure(command: string, error: unknown) {
  if (!(error instanceof SourceAdmissionError)) return undefined;
  return failure(command, 1, {
    code: "SOURCE_REJECTED", message: "Application source is outside the approved Fleur surface.",
    actual: { ...error.diagnostic },
    actions: [{ command: `fleur ${command}`, description: error.diagnostic.action }],
  });
}
