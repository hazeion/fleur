import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Requirements: docs/planning/V1-SPEC.md "Schema inspection and database health" (#72).
// These cases need no database: they cover configuration, unreachable targets and the probe deadline.
interface Outcome { exit: number; stdout: string; elapsedMs: number; result: { command: string; ok: boolean; data: Record<string, unknown> | null; error: { code: string; actions: { command: string; description: string }[] } | null } }
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fleur-db-health-"));
  await writeFile(join(root, "fleur.json"), JSON.stringify({ formatVersion: 1, fleurVersion: "0.1.0", contractVersion: 1, compiler: "microsoft" }));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function cli(args: string[], environment: Record<string, string | undefined> = {}): Promise<Outcome> {
  // Only the configuration under test reaches the command; inherited private settings never do.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("FLEUR_PRIVATE_")) env[key] = value;
  for (const [key, value] of Object.entries({ FLEUR_PRIVATE_STATE_ROOT: root, ...environment })) if (value !== undefined) env[key] = value;
  const started = performance.now();
  const child = Bun.spawn([process.execPath, resolve("bin/fleur.ts"), ...args, "--project", root, "--json"], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const elapsedMs = performance.now() - started;
  expect(stderr).toBe("");
  return { exit, stdout, elapsedMs, result: JSON.parse(stdout) };
}
/** A closed loopback port: connections are refused. */
async function refusedPort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
function expectNoEndpoint(outcome: Outcome, endpoint: { url: string; user: string; password: string; port: number }) {
  for (const secret of [endpoint.url, endpoint.user, endpoint.password, "127.0.0.1", "postgres://", "postgresql://"]) expect(outcome.stdout).not.toContain(secret);
  const values: unknown[] = [];
  const walk = (value: unknown) => { if (value && typeof value === "object") Object.values(value).forEach(walk); else values.push(value); };
  walk(outcome.result);
  expect(values).not.toContain(endpoint.port);
  expect(values).not.toContain(String(endpoint.port));
}

test("status is a catalogued command and status and db inspect admit the shared production option", async () => {
  const help = await cli(["--help"]);
  const commands = (help.result.data as { commands: { name: string; options?: { name: string; value: boolean }[] }[] }).commands;
  for (const name of ["status", "db inspect", "db migration status"]) expect(commands.find(command => command.name === name)?.options).toContainEqual({ name: "--production", value: false });
  for (const args of [["status", "--table", "x"], ["status", "extra"], ["status", "--production", "yes"], ["db", "inspect", "--production", "--production"]]) {
    const outcome = await cli(args);
    expect({ args, exit: outcome.exit, code: outcome.result.error?.code }).toEqual({ args, exit: 2, code: "ARGUMENT_INVALID" });
  }
});

test("a production target without explicit credentials returns CONFIGURATION_MISSING", async () => {
  const development = "postgres://dev:secret@127.0.0.1:1/devdb";
  for (const environment of [{}, { FLEUR_PRIVATE_DATABASE_URL: "postgres://127.0.0.1:1/appdb" }, { FLEUR_PRIVATE_DATABASE_URL: development, FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: development }]) {
    for (const args of [["status", "--production"], ["db", "inspect", "--production"], ["db", "inspect", "--table", "exercises", "--production"], ["db", "migration", "status", "--production"]]) {
      const outcome = await cli(args, environment);
      expect({ args, environment, exit: outcome.exit, code: outcome.result.error?.code }).toEqual({ args, environment, exit: 4, code: "CONFIGURATION_MISSING" });
      expect(outcome.stdout).not.toContain("secret");
    }
  }
});

test("the default development target refuses a configured database that differs from the supplied development binding", async () => {
  const environment = { FLEUR_PRIVATE_DATABASE_URL: "postgres://app:secret@127.0.0.1:1/appdb", FLEUR_PRIVATE_DEVELOPMENT_DATABASE_URL: "postgres://dev:secret@127.0.0.1:1/devdb" };
  for (const args of [["status"], ["db", "inspect"], ["db", "migration", "status"]]) {
    const outcome = await cli(args, environment);
    expect({ args, exit: outcome.exit, code: outcome.result.error?.code }).toEqual({ args, exit: 4, code: "CONFIGURATION_MISSING" });
  }
});

test("status against a refusing database exits 0 with the unavailable reason, its action and no endpoint details", async () => {
  const port = await refusedPort();
  const endpoint = { url: `postgres://health_user:health_password@127.0.0.1:${port}/workout_app`, user: "health_user", password: "health_password", port };
  for (const production of [false, true]) {
    const outcome = await cli(["status", ...(production ? ["--production"] : [])], { FLEUR_PRIVATE_DATABASE_URL: endpoint.url });
    expect(outcome.exit).toBe(0);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.elapsedMs).toBeLessThan(5_000 + 3_000);
    const data = outcome.result.data as { ready: boolean; reasons: { code: string; message: string; action: { command: string; description: string } }[]; database: { connectivity: string; failure: string; target: Record<string, unknown>; migrations: unknown } };
    expect(data.ready).toBe(false);
    expect(data.database).toMatchObject({ connectivity: "unreachable", failure: "refused", target: { kind: production ? "production" : "development", database: "workout_app", serverVersion: null, fingerprint: null }, migrations: null });
    expect(data.reasons.map(reason => reason.code)).toEqual(["DATABASE_UNAVAILABLE"]);
    expect(data.reasons[0]!.action.command).toBeString();
    expect(data.reasons[0]!.action.description).toBeString();
    expectNoEndpoint(outcome, endpoint);
  }
}, 30_000);

test("status reports a silent database as unreachable within its own probe deadline, adjusted by --timeout", async () => {
  const sockets: { end(): void }[] = [];
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { sockets.push(socket); }, data() {} } });
  const endpoint = { url: `postgres://health_user:health_password@127.0.0.1:${silent.port}/workout_app`, user: "health_user", password: "health_password", port: silent.port };
  try {
    const adjusted = await cli(["status", "--timeout", "1"], { FLEUR_PRIVATE_DATABASE_URL: endpoint.url });
    expect(adjusted.exit).toBe(0);
    expect(adjusted.result.data).toMatchObject({ database: { connectivity: "unreachable", failure: "timeout" } });
    expect((adjusted.result.data as { reasons: { code: string }[] }).reasons.map(reason => reason.code)).toEqual(["DATABASE_UNAVAILABLE"]);
    expect(adjusted.elapsedMs).toBeLessThan(1_000 + 3_000);
    expectNoEndpoint(adjusted, endpoint);
    const standard = await cli(["status"], { FLEUR_PRIVATE_DATABASE_URL: endpoint.url });
    expect(standard.exit).toBe(0);
    expect(standard.result.data).toMatchObject({ database: { connectivity: "unreachable", failure: "timeout" } });
    // The probe has its own 5 s default rather than the 60 s command default. The deadline is an upper bound: the
    // connection attempt may give up sooner. tests/runtime/schema-overview.integration.test.ts holds a probe for the
    // full deadline against a real database.
    expect(standard.elapsedMs).toBeLessThan(5_000 + 3_000);
  } finally { for (const socket of sockets) socket.end(); silent.stop(true); }
}, 40_000);

test("commands that need data from an unreachable database return DATABASE_UNAVAILABLE with exit 4", async () => {
  const port = await refusedPort();
  const endpoint = { url: `postgres://health_user:health_password@127.0.0.1:${port}/workout_app`, user: "health_user", password: "health_password", port };
  for (const args of [["db", "inspect", "--table", "exercises"], ["db", "inspect"], ["db", "migration", "status"]]) {
    const outcome = await cli(args, { FLEUR_PRIVATE_DATABASE_URL: endpoint.url });
    expect({ args, exit: outcome.exit, code: outcome.result.error?.code }).toEqual({ args, exit: 4, code: "DATABASE_UNAVAILABLE" });
    expect(outcome.result.error!.actions.length).toBeGreaterThan(0);
    expectNoEndpoint(outcome, endpoint);
  }
}, 30_000);
