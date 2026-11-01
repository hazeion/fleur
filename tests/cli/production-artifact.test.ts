import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import release from "../../package.json" with { type: "json" };
import { artifactIdentity, type ArtifactManifest } from "../../src/runtime/production/artifact";

const executable = resolve(import.meta.dir, "../../bin/fleur.ts");
const scratch = await realpath(await mkdtemp(join(tmpdir(), "fleur-artifact-cli-")));
afterAll(() => rm(scratch, { recursive: true, force: true }));
// A Docker probe would prove too much: every refusal here precedes any Docker command.
const noDocker = join(scratch, "no-docker");
await mkdir(noDocker);
async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, executable, ...args, "--json"], { cwd: scratch, env: { PATH: noDocker, HOME: scratch }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  return { exit, stderr, lines, last: lines.at(-1) as { ok?: boolean; error?: { code: string }; event?: string; data?: { result?: { error?: { code: string; expected?: unknown; actual?: unknown } }; exitCode?: number } } };
}
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const refusal = (outcome: Awaited<ReturnType<typeof cli>>) => outcome.last.data?.result?.error?.code ?? outcome.last.error?.code;
const [hostMajor, hostMinor, hostPatch] = Bun.version.split(".").map(Number) as [number, number, number];

/** A structurally valid artifact whose contents are small enough to corrupt cheaply. */
async function artifact(name: string, change: (manifest: Omit<ArtifactManifest, "id">) => Omit<ArtifactManifest, "id"> = value => value) {
  const directory = join(scratch, name);
  const contents = { "supervisor/entry.js": "process.exit(99);\n", "supervisor/control-worker.js": "process.exit(99);\n", "client/index.json": "{}\n", "manifest/registry.json": "{}\n", "manifest/dependencies.json": "{}\n", "images/execution.oci.tar": "archive\n" };
  await mkdir(directory);
  for (const [path, body] of Object.entries(contents)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), body);
  }
  const role = (tag: string) => ({ tag, identities: [`sha256:${"a".repeat(64)}`] });
  const base = change({
    formatVersion: 1, fleurVersion: release.version, bun: Bun.version, compiler: "microsoft", project: "b".repeat(64),
    platform: { os: "linux", architecture: process.arch === "arm64" ? "arm64" : "amd64" },
    images: { archive: "images/execution.oci.tar", worker: role("fleur-read-build-a-worker:latest"), controller: role("fleur-read-build-a-controller:latest") },
    files: Object.entries(contents).map(([path, body]) => ({ path, sha256: sha256(body), bytes: body.length })).sort((a, b) => a.path < b.path ? -1 : 1),
  });
  await writeFile(join(directory, "fleur-artifact.json"), JSON.stringify({ ...base, id: artifactIdentity(base) }));
  return directory;
}

test("the catalog publishes the approved build and start grammar", async () => {
  const commands = (await cli("--help")).lines[0]!.data as { commands: { name: string; usage?: string; options?: unknown }[] };
  expect(commands.commands).toContainEqual({ name: "build", usage: "build", summary: "Build an immutable, self-contained production artifact.", options: [] } as never);
  expect(commands.commands).toContainEqual({ name: "start", usage: "start --artifact <dir> [--host <address>] [--port <number>]", summary: "Serve a verified production artifact against configured PostgreSQL.", options: [{ name: "--artifact", value: true }, { name: "--host", value: true }, { name: "--port", value: true }] } as never);
});
test("start rejects invalid syntax before reading anything", async () => {
  for (const args of [["start"], ["start", "--artifact", "x", "--port", "0"], ["start", "--artifact", "x", "--port", "70000"], ["start", "--artifact", "x", "--host", "not a host"], ["start", "--artifact", "x", "extra"], ["start", "--artifact", "x", "--background"], ["build", "extra"]]) {
    const outcome = await cli(...args);
    expect(outcome.exit, args.join(" ")).toBe(2);
    expect(refusal(outcome)).toBe("ARGUMENT_INVALID");
  }
});
test("a missing artifact fails without any Docker command", async () => {
  const outcome = await cli("start", "--artifact", join(scratch, "absent"));
  expect(outcome.exit).toBe(4);
  expect(refusal(outcome)).toBe("ARTIFACT_INVALID");
});
test("a corrupted, truncated or extended artifact fails before its supervisor is evaluated", async () => {
  const corrupt = await artifact("corrupt");
  await writeFile(join(corrupt, "images/execution.oci.tar"), "tampered\n");
  const missing = await artifact("missing");
  await rm(join(missing, "images/execution.oci.tar"));
  const extended = await artifact("extended");
  await writeFile(join(extended, ".env"), "SECRET=value\n");
  const supervisor = await artifact("supervisor");
  await writeFile(join(supervisor, "supervisor/entry.js"), "process.exit(98);\n");
  const manifest = await artifact("manifest");
  await writeFile(join(manifest, "fleur-artifact.json"), "{");
  for (const directory of [corrupt, missing, extended, supervisor, manifest]) {
    const outcome = await cli("start", "--artifact", directory);
    expect(outcome.exit, directory).toBe(4);
    expect(refusal(outcome), directory).toBe("ARTIFACT_INVALID");
  }
});
test("a manifest edited after publication fails its identity check", async () => {
  const directory = await artifact("edited");
  const path = join(directory, "fleur-artifact.json");
  const manifest = JSON.parse(await Bun.file(path).text()) as ArtifactManifest;
  await writeFile(path, JSON.stringify({ ...manifest, project: "c".repeat(64) }));
  expect(refusal(await cli("start", "--artifact", directory))).toBe("ARTIFACT_INVALID");
});
test("an artifact for another Fleur release or architecture is incompatible", async () => {
  const changes: ((manifest: Omit<ArtifactManifest, "id">) => Omit<ArtifactManifest, "id">)[] = [
    value => ({ ...value, fleurVersion: "0.0.1" }),
    value => ({ ...value, platform: { os: "linux", architecture: process.arch === "arm64" ? "amd64" : "arm64" } }),
  ];
  for (const [index, change] of changes.entries()) {
    const outcome = await cli("start", "--artifact", await artifact(`incompatible-${index}`, change));
    expect(outcome.exit, String(index)).toBe(4);
    expect(refusal(outcome), String(index)).toBe("ARTIFACT_INCOMPATIBLE");
  }
});
test("an artifact built by an older Bun is admitted when its release and architecture match", async () => {
  // Verification passed when the next check, database configuration, is the one reported.
  const outcome = await cli("start", "--artifact", await artifact("older-bun", value => ({ ...value, bun: "1.0.0" })));
  expect(outcome.exit).toBe(4);
  expect(refusal(outcome)).toBe("CONFIGURATION_MISSING");
});
test("an artifact built by a newer Bun is incompatible and reports both versions", async () => {
  // Compared numerically: a patch such as 1.4.13 is above 1.4.3 although it sorts below it as text.
  for (const [index, bun] of ["99.0.0", `${hostMajor}.${hostMinor + 1}.0`, `${hostMajor}.${hostMinor}.1${hostPatch}`].entries()) {
    const outcome = await cli("start", "--artifact", await artifact(`newer-bun-${index}`, value => ({ ...value, bun })));
    expect(outcome.exit, bun).toBe(4);
    expect(refusal(outcome), bun).toBe("ARTIFACT_INCOMPATIBLE");
    expect(outcome.last.data?.result?.error, bun).toMatchObject({ expected: bun, actual: Bun.version });
  }
});
test("a manifest whose Bun is not a plain version is invalid before any comparison", async () => {
  for (const [index, bun] of [">=1.4.3", "1.4", "1.4.3-canary.20261101", "v1.4.3", "1.4.3 "].entries()) {
    const outcome = await cli("start", "--artifact", await artifact(`malformed-bun-${index}`, value => ({ ...value, bun })));
    expect(outcome.exit, bun).toBe(4);
    expect(refusal(outcome), bun).toBe("ARTIFACT_INVALID");
  }
});
test("a valid artifact without database configuration names only the missing configuration", async () => {
  const outcome = await cli("start", "--artifact", await artifact("unconfigured"));
  expect(outcome.exit).toBe(4);
  expect(refusal(outcome)).toBe("CONFIGURATION_MISSING");
});
test("an artifact smoke container requires the exact image identity and overrides its entrypoint", async () => {
  const { smokeContainer } = await import("../../src/setup/smoke");
  const image = `sha256:${"d".repeat(64)}`;
  const metadata = (id: string) => JSON.stringify({ Id: id, Os: "linux", Architecture: "amd64", RepoDigests: [] });
  const issued: (readonly string[])[] = [];
  let created = "";
  const run = async (args: readonly string[]) => {
    issued.push(args);
    const name = args[args.indexOf("--name") + 1];
    if (args.includes("create")) { created = name!; return { status: "completed", exitCode: 0, stdout: `${"e".repeat(64)}\n`, stderr: "" } as const; }
    const label = issued.find(item => item.includes("create"))?.find(item => item.startsWith("dev.fleur.doctor-owner="))?.split("=")[1];
    if (args.includes("inspect")) return { status: "completed", exitCode: 0, stdout: JSON.stringify({ Id: "e".repeat(64), Name: `/${created}`, Image: image, Config: { Labels: { "dev.fleur.doctor-owner": label } }, State: { Running: false, ExitCode: 0, FinishedAt: "2026-10-30T00:00:00Z" } }), stderr: "" } as const;
    return { status: "completed", exitCode: 0, stdout: args.includes("start") ? "fleur-doctor-smoke" : "", stderr: "" } as const;
  };
  expect(await smokeContainer(run, "unix:///x.sock", image, metadata(image), "x64", run, true)).toEqual({ state: "ready", cleanup: true });
  const create = issued.find(args => args.includes("create"))!;
  expect(create.slice(create.indexOf("--entrypoint"), create.indexOf("--entrypoint") + 3)).toEqual(["--entrypoint", "/usr/local/bin/bun", image]);
  expect(await smokeContainer(run, "unix:///x.sock", image, metadata(`sha256:${"f".repeat(64)}`), "x64", run, true)).toMatchObject({ state: "failed", reason: "image-identity" });
  // An ordinary Doctor smoke still requires the pinned repository digest.
  expect(await smokeContainer(run, "unix:///x.sock", image, metadata(image), "x64", run)).toMatchObject({ state: "failed", reason: "image-identity" });
});
