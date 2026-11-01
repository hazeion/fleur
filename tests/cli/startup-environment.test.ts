import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import release from "../../package.json" with { type: "json" };
import { artifactIdentity, type ArtifactManifest } from "../../src/runtime/production/artifact";

const executable = resolve(import.meta.dir, "../../bin/fleur.ts");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "fleur-startup-environment-")));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

/** A caller directory holding every file Bun would load by default, each trying to supply configuration. */
async function callerDirectory(name: string, project: Record<string, unknown> | null = { formatVersion: 1, contractVersion: 1, compiler: "microsoft", fleurVersion: release.version }) {
  const directory = join(scratch, name);
  await mkdir(directory);
  for (const file of [".env", ".env.local", ".env.production", ".env.development"]) await writeFile(join(directory, file), `FLEUR_PRIVATE_DATABASE_URL=postgres://dotenv:dotenv@127.0.0.1:1/dotenv\nFLEUR_DOTENV_CANARY=${file}\nFLEUR_REAL_SETTING=${file}\n`);
  if (project) await writeFile(join(directory, "fleur.json"), JSON.stringify(project));
  return directory;
}
async function cli(cwd: string, environment: Record<string, string>, ...args: string[]) { return bunCli([], cwd, environment, ...args); }
async function bunCli(bunOptions: readonly string[], cwd: string, environment: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, ...bunOptions, executable, ...args, "--json"], { cwd, env: { PATH: "/usr/bin:/bin", HOME: scratch, ...environment }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  const last = lines.at(-1) as { error?: { code: string }; data?: { result?: { ok: boolean; error?: { code: string } | null } } };
  return { exit, stderr, code: last.data?.result ? last.data.result.error?.code : last.error?.code, ok: last.data?.result?.ok };
}
/** A verifiable artifact whose supervisor only records the environment it was handed. */
async function observingArtifact(name: string) {
  const directory = join(scratch, name);
  const contents: Record<string, string> = {
    "supervisor/entry.js": 'await Bun.write(process.env.FLEUR_TEST_OBSERVED, JSON.stringify(process.env));\nconsole.log(JSON.stringify({ event: "stopped" }));\n',
    "supervisor/control-worker.js": "process.exit(99);\n", "client/index.json": "{}\n", "manifest/registry.json": "{}\n", "manifest/dependencies.json": "{}\n", "images/execution.oci.tar": "archive\n",
  };
  for (const [path, body] of Object.entries(contents)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), body);
  }
  const role = (tag: string) => ({ tag, identities: [`sha256:${"a".repeat(64)}`] });
  const base: Omit<ArtifactManifest, "id"> = {
    formatVersion: 1, fleurVersion: release.version, bun: Bun.version, compiler: "microsoft", project: "b".repeat(64),
    platform: { os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64" },
    images: { archive: "images/execution.oci.tar", worker: role("fleur-read-build-a-worker:latest"), controller: role("fleur-read-build-a-controller:latest") },
    files: Object.entries(contents).map(([path, body]) => ({ path, sha256: sha256(body), bytes: body.length })).sort((a, b) => a.path < b.path ? -1 : 1),
  };
  await writeFile(join(directory, "fleur-artifact.json"), JSON.stringify({ ...base, id: artifactIdentity(base) }));
  return directory;
}

test("a production database named only by a .env file is not configuration", async () => {
  const cwd = await callerDirectory("database");
  for (const environment of [{}, { NODE_ENV: "production" }, { NODE_ENV: "development" }] as Record<string, string>[]) {
    const outcome = await cli(cwd, environment, "db", "inspect", "--production", "--timeout", "5");
    expect(outcome.code, JSON.stringify(environment)).toBe("CONFIGURATION_MISSING");
  }
});
test("start refuses when private configuration exists only in a .env file", async () => {
  const cwd = await callerDirectory("start-refused", null);
  const outcome = await cli(cwd, {}, "start", "--artifact", await observingArtifact("artifact-refused"));
  expect(outcome.code).toBe("CONFIGURATION_MISSING");
  expect(outcome.exit).toBe(4);
});
test("start gives its supervisor exactly the real startup environment", async () => {
  const cwd = await callerDirectory("start-observed", null), observed = join(scratch, "observed.json");
  const outcome = await cli(cwd, { FLEUR_PRIVATE_DATABASE_URL: "postgres://real:real@127.0.0.1:1/real", FLEUR_REAL_SETTING: "real", FLEUR_TEST_OBSERVED: observed }, "start", "--artifact", await observingArtifact("artifact-observed"));
  expect(outcome.ok, outcome.stderr).toBe(true);
  const environment = await Bun.file(observed).json() as Record<string, string>;
  expect(environment).toMatchObject({ FLEUR_PRIVATE_DATABASE_URL: "postgres://real:real@127.0.0.1:1/real", FLEUR_REAL_SETTING: "real" });
  expect(environment.FLEUR_DOTENV_CANARY).toBeUndefined();
});
test("arguments and exit status survive the launcher's clean start", async () => {
  const cwd = await callerDirectory("arguments", null);
  const environment = { FLEUR_PRIVATE_DATABASE_URL: "postgres://real:real@127.0.0.1:1/real", FLEUR_TEST_OBSERVED: join(scratch, "arguments.json") };
  // Only the exact path names the artifact, so reaching its supervisor proves the argument arrived intact.
  expect((await cli(cwd, environment, "start", "--artifact", await observingArtifact("artifact with space\nand newline"))).ok).toBe(true);
  const refused = await cli(cwd, {}, "start", "--artifact", join(scratch, "absent"));
  expect(refused.code).toBe("ARTIFACT_INVALID");
  expect(refused.exit).toBe(4);
});
test("Bun's --cwd selects the working directory once", async () => {
  const parent = await callerDirectory("working-directory"), selected = await callerDirectory("working-directory/sub");
  await mkdir(join(selected, "sub"));
  await writeFile(join(selected, "sub/fleur.json"), JSON.stringify({ formatVersion: 1, contractVersion: 1, compiler: "microsoft", fleurVersion: "0.0.9" }));
  for (const options of [["--cwd=sub"], ["--cwd", "sub"]]) {
    // A second application lands in sub/sub, whose different pin reports VERSION_MISMATCH instead.
    const outcome = await bunCli(options, parent, {}, "db", "inspect", "--production", "--timeout", "5");
    expect(outcome.code, options.join(" ")).toBe("CONFIGURATION_MISSING");
  }
});
test("a delegated project release does not load .env files either", async () => {
  const cwd = await callerDirectory("delegated", { fleurVersion: "0.0.9" }), local = join(cwd, "node_modules/fleur");
  await mkdir(join(local, "bin"), { recursive: true });
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "fleur", version: "0.0.9", bin: "bin/fleur.ts" }));
  await writeFile(join(local, "bin/fleur.ts"), 'await Bun.write("observed.json", JSON.stringify(process.env));');
  const child = Bun.spawn([process.execPath, executable, "new", "child", "--no-git", "--json"], { cwd, env: { PATH: "", HOME: scratch, FLEUR_REAL_SETTING: "real" }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const environment = await Bun.file(join(cwd, "observed.json")).json() as Record<string, string>;
  expect(environment.FLEUR_REAL_SETTING).toBe("real");
  expect(environment.FLEUR_DOTENV_CANARY).toBeUndefined();
});
test("the development supervisor does not load .env files from the caller's directory", async () => {
  const cwd = await callerDirectory("development", null), project = join(scratch, "development-app"), tools = join(scratch, "development-tools"), recorded = join(scratch, "development-docker.log");
  await mkdir(tools);
  await writeFile(join(tools, "docker"), `#!/bin/sh\nprintf 'canary=%s real=%s\\n' "$FLEUR_DOTENV_CANARY" "$FLEUR_REAL_SETTING" >> '${recorded}'\nexit 1\n`, { mode: 0o700 });
  try {
    expect((await cli(cwd, {}, "new", project, "--no-git")).exit).toBe(0);
    await cli(cwd, { PATH: `${tools}:/usr/bin:/bin`, FLEUR_REAL_SETTING: "real", DOCKER_HOST: "unix:///nonexistent/fleur-startup-environment.sock" }, "dev", "--background", "--project", project);
    const calls = (await Bun.file(recorded).text()).trim().split("\n");
    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls)]).toEqual(["canary= real=real"]);
  } finally { await cli(cwd, {}, "stop", "--project", project); }
});
test("every Bun process Fleur starts declines .env files", async () => {
  const unguarded: string[] = [];
  const source = resolve(import.meta.dir, "../../src");
  for (const path of await readdir(source, { recursive: true })) {
    if (!path.endsWith(".ts")) continue;
    const text = await Bun.file(join(source, path)).text();
    for (const [launch] of text.matchAll(/\[process\.execPath, [^,]+|`\$\{process\.execPath\} [^`]{0,16}/g)) if (!launch.includes("--no-env-file")) unguarded.push(`${path}: ${launch}`);
  }
  expect(unguarded).toEqual([]);
});
