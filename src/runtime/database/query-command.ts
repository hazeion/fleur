import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { CommandDefinition } from "../../cli/catalog";
import { failure, success } from "../../cli/result";
import { privilegeShortfall } from "./privilege";
import { databaseFailure } from "./commands";

const invalid = () => failure("db query", 2, { code: "ARGUMENT_INVALID", message: "Supply one --sql or --sql-file, optional text --param values, --limit from 1 to 500 and --timeout up to 30 seconds.", actions: [] });
export const queryCommand: CommandDefinition = {
  name: "db query", summary: "Run one bounded read-only SQL statement against owned development data.",
  usage: "db query (--sql <text> | --sql-file <path>) [--param <text>]... [--limit 100]",
  options: ["--sql", "--sql-file", "--param", "--limit"].map(name => ({ name, value: true, ...(name === "--param" ? { repeatable: true } : {}), ...(["--param", "--sql"].includes(name) ? { text: true } : {}) })),
  validateArgs(args) {
    let sources = 0;
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!["--sql", "--sql-file", "--param", "--limit"].includes(flag!) || value === undefined || value.includes("\0")) return invalid();
      if (flag === "--sql" || flag === "--sql-file") sources++;
      if (flag === "--sql" && (!value.trim() || Buffer.byteLength(value) > 65536)) return invalid();
      if (flag === "--limit" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500)) return invalid();
    }
    return sources === 1 && args.filter((arg, index) => index % 2 === 0 && arg === "--param").length <= 65534 ? undefined : invalid();
  },
  async run({ args, project, timeoutSeconds, timeoutExplicit }) {
    if (timeoutExplicit && timeoutSeconds > 30) return invalid();
    const values = new Map(args.flatMap((arg, index) => index % 2 === 0 ? [[arg, args[index + 1]!] as const] : []));
    const value = (flag: string) => values.get(flag)!;
    let text = values.has("--sql") ? value("--sql") : "";
    if (values.has("--sql-file")) {
      let file;
      try {
        file = await open(resolve(project, value("--sql-file")), constants.O_RDONLY | constants.O_NONBLOCK);
        const info = await file.stat();
        if (!info.isFile() || info.size > 65536) return invalid();
        const bytes = Buffer.alloc(65537);
        let size = 0;
        while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
        if (size > 65536) return invalid();
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
        if (!text.trim() || text.includes("\0")) return invalid();
      } catch { return invalid(); } finally { await file?.close(); }
    }
    try {
      const { developmentQuery } = await import("./query");
      const result = await developmentQuery(project, { sql: text, params: args.flatMap((arg, index) => index % 2 === 0 && arg === "--param" ? [args[index + 1]!] : []), limit: values.has("--limit") ? Number(value("--limit")) : 100, timeoutMs: timeoutExplicit ? timeoutSeconds * 1000 : 5000 });
      const outcome = success("db query", result);
      return { ...outcome, result: { ...outcome.result, truncated: result.truncated } };
    } catch (error) {
      const { QueryRejected } = await import("./query");
      if (error instanceof QueryRejected) return failure("db query", 1, { code: "DATABASE_QUERY_REJECTED", message: error.message, actual: error.diagnostic, actions: [{ command: "fleur db query --help", description: "Use one SELECT, WITH without data-modifying parts, VALUES or TABLE statement with bound text parameters." }] });
      const shortfall = privilegeShortfall(error);
      if (shortfall) return failure("db query", 4, { code: "DATABASE_PRIVILEGE_INSUFFICIENT", message: "The restricted development diagnostic credential could not be verified. No diagnostic statement ran.", expected: { capability: shortfall.capability }, actions: [{ command: "fleur db query --help", description: "Review the diagnostic credential requirements under Development SQL diagnosis in package docs/maintenance.md." }] });
      return databaseFailure("db query", error, ["ARGUMENT_INVALID", "DATABASE_UNAVAILABLE", "MAINTENANCE_BUSY", "QUERY_TIMEOUT", "RESULT_TOO_LARGE"], { command: "fleur db query --help", description: "Check the read-only statement and development database state before retrying." });
    }
  },
};
