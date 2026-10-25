import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { databaseUrl } from "./maintenance";

export async function fileDigest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}
/** Trusted host tools only. No application handler receives these credentials or executable selection. */
export async function pgTool(tool: "pg_dump" | "pg_restore" | "psql", args: readonly string[], urlValue: string, io: { output?: string; input?: string; timeoutMs: number; directory?: string }): Promise<void> {
  const url = databaseUrl(urlValue);
  const output = io.output ? await open(io.output, "wx", 0o600) : undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn([io.directory ? join(io.directory, tool) : tool, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", PGHOST: url.hostname, PGPORT: url.port || "5432", PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "3", PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=3000 -c timezone=UTC -c datestyle=ISO,YMD", PGPASSFILE: "/dev/null", PGSERVICEFILE: "/dev/null" },
      stdin: io.input ? Bun.file(io.input) : "ignore", stdout: output ? output.fd : "ignore", stderr: "ignore",
    });
    let expired = false;
    timer = setTimeout(() => { expired = true; child?.kill("SIGKILL"); }, Math.max(1, io.timeoutMs));
    const code = await child.exited;
    if (expired || code !== 0) throw new Error("BACKUP_VERIFICATION_FAILED");
    if (output) await output.sync();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error("PREREQUISITE_UNAVAILABLE");
    throw error;
  } finally { clearTimeout(timer); await output?.close(); }
}

export const schemaDumpArguments=["--schema-only","--no-owner","--no-acl","--restrict-key=FleurBackupVerificationV1","--no-password"] as const;
