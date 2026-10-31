import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import release from "../../../package.json" with { type: "json" };
import type { CommandInput } from "../../cli/catalog";
import { failure, success, type CliOutcome, type ExitCode } from "../../cli/result";
import { doctor } from "../../setup/doctor";
import { productionHost } from "../../setup/host";
import { admitProject, type AdmittedProject } from "../build/admission";
import { compileClient, type BrowserBuild } from "../build/client";
import { SourceAdmissionError } from "../build/diagnostics";
import { compileWorker } from "../build/worker";
import { readMigrations } from "../database/migration-plan";
import { snapshotSignature } from "../database/migration-state";
import { describeTables } from "../table-wire";
import { binding } from "../development/state";
import { restoreManifest } from "../manifest-wire";
import { prepareNativeImages } from "../native/build";
import { nativeCommand } from "../native/command";
import { startWorker } from "../native/host";
import { artifactFiles, artifactIdentity, fileDigest, manifestName, projectKey, type ArtifactManifest } from "./artifact";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const archiveName = "images/execution.oci.tar";
const metadata = z.object({ projectId: z.string().uuid().optional() });

/** Save-time identities: the config digest (classic store) and the index entry digest (containerd store). */
async function savedIdentities(archive: string, tag: string): Promise<string[]> {
  const read = async (name: string) => {
    const child = Bun.spawn(["tar", "-xOf", archive, name], { stdout: "pipe", stderr: "ignore" });
    const [text, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (exit !== 0) throw new Error("ARTIFACT_INVALID");
    return JSON.parse(text) as unknown;
  };
  const entries = z.array(z.object({ Config: z.string().regex(/^blobs\/sha256\/[a-f0-9]{64}$/), RepoTags: z.array(z.string()) })).parse(await read("manifest.json"));
  const entry = entries.find(item => item.RepoTags.includes(tag));
  if (!entry) throw new Error("ARTIFACT_INVALID");
  const index = z.object({ manifests: z.array(z.object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), annotations: z.record(z.string(), z.string()).optional() })) }).parse(await read("index.json"));
  const named = index.manifests.find(item => item.annotations?.["io.containerd.image.name"]?.endsWith(`/${tag}`));
  return [`sha256:${entry.Config.slice("blobs/sha256/".length)}`, ...named ? [named.digest] : []];
}
/** Sources outside the project are named by file only, so no machine path reaches the artifact or browser. */
function portableSourceMap(body: string | Uint8Array, root: string): string {
  const map = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body)) as { sources?: string[] };
  map.sources = (map.sources ?? []).map(source => {
    const absolute = resolve(root, "assets", source);
    return absolute.startsWith(`${root}/`) ? relative(root, absolute) : `fleur/${basename(source)}`;
  });
  return JSON.stringify(map);
}
async function writeClient(directory: string, browser: BrowserBuild, root: string) {
  await mkdir(join(directory, "client/files"), { recursive: true });
  const files = [];
  for (const [index, [path, value]] of [...browser.files].entries()) {
    const file = `client/files/${String(index).padStart(5, "0")}`;
    await writeFile(join(directory, file), path.endsWith(".map") ? portableSourceMap(value.body, root) : value.body);
    files.push({ path, file, type: value.type, ...value.cache ? { cache: value.cache } : {} });
  }
  await writeFile(join(directory, "client/index.json"), JSON.stringify({ entry: browser.entry, ...browser.module ? { module: browser.module } : {}, ...browser.compatibility ? { compatibility: browser.compatibility } : {}, ...browser.stylesheet ? { stylesheet: browser.stylesheet } : {}, files }));
}
/** All supervisor code and dependencies, so serving reads nothing from source or an installed package. */
async function writeSupervisor(directory: string) {
  const result = await Bun.build({ entrypoints: [fileURLToPath(new URL("entry.ts", import.meta.url)), fileURLToPath(new URL("../database/control-worker.ts", import.meta.url))], target: "bun", format: "esm", naming: "[name].js", minify: { whitespace: true }, sourcemap: "none" });
  if (!result.success || result.outputs.length !== 2) throw new Error("Supervisor bundle failed");
  await mkdir(join(directory, "supervisor"), { recursive: true });
  for (const output of result.outputs) await writeFile(join(directory, "supervisor", basename(output.path)), await output.text());
}
async function writeDocumentation(directory: string) {
  await mkdir(join(directory, "docs"), { recursive: true });
  for (const file of release.files) if (file.startsWith("docs/")) await cp(join(repository, file), join(directory, file));
}
/**
 * Writes one artifact from admitted source. Explicit image acquisition happens
 * here, never at start. Nothing outside these named outputs enters the directory,
 * so secrets, machine configuration, volumes, logs and caches have no path in.
 */
export async function writeArtifact(source: AdmittedProject, project: string, output: string): Promise<{ readonly id: string; readonly directory: string; readonly manifest: ArtifactManifest }> {
  const plans = await readMigrations(project);
  const browser = await compileClient(source), compiled = await compileWorker(source);
  const key = metadata.parse(JSON.parse(await Bun.file(join(project, "fleur.json")).text())).projectId;
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, ".next-"));
  let images: Awaited<ReturnType<typeof prepareNativeImages>> | undefined;
  try {
    images = await prepareNativeImages(compiled);
    const { endpoint } = images;
    const worker = await startWorker(images), session = crypto.randomUUID();
    let registry: unknown;
    try {
      const result = await worker.run({ mode: "register", session }, () => { throw new Error("REQUEST_DENIED"); });
      if (!result || typeof result !== "object" || !("value" in result)) throw new Error("SOURCE_REJECTED");
      registry = result.value;
    } finally { await worker.close(); }
    const tables = restoreManifest(registry).tables;
    // Start would always refuse: a declaration change has no reviewed migration yet.
    if (snapshotSignature(describeTables(tables)) !== snapshotSignature(plans.at(-1)?.snapshot ?? [])) throw new Error("MIGRATIONS_PENDING");
    await mkdir(join(directory, "manifest"));
    await writeFile(join(directory, "manifest/registry.json"), JSON.stringify(registry));
    await writeFile(join(directory, "manifest/dependencies.json"), JSON.stringify({ fleur: release.version, bun: release.engines.bun, runtime: release.dependencies }));
    await mkdir(join(directory, "schema/migrations"), { recursive: true });
    for (const name of await readdir(join(project, "migrations")).catch(() => [] as string[])) await cp(join(project, "migrations", name), join(directory, "schema/migrations", name));
    await writeClient(directory, browser, source.root);
    await mkdir(join(directory, "server"));
    await writeFile(join(directory, "server/application.js"), compiled);
    await writeSupervisor(directory);
    await writeDocumentation(directory);
    const architecture = await nativeCommand(["docker", "--host", endpoint, "info", "--format", "{{.Architecture}}"]);
    const tags = await Promise.all(["worker", "controller"].map(async role => {
      const found = await nativeCommand(["docker", "--host", endpoint, "image", "inspect", images![role as "worker" | "controller"], "--format", "{{json .RepoTags}}"]);
      const tag = (JSON.parse(found) as string[]).find(name => name.startsWith("fleur-read-build-") && name.endsWith(`-${role}:latest`));
      if (!tag) throw new Error("ARTIFACT_INVALID");
      return tag;
    }));
    await mkdir(join(directory, "images"));
    await nativeCommand(["docker", "--host", endpoint, "save", "--output", join(directory, archiveName), tags[0]!, tags[1]!], 300_000);
    const files = [];
    for (const path of await artifactFiles(directory)) files.push({ path, ...await fileDigest(join(directory, path)) });
    const content: Omit<ArtifactManifest, "id"> = {
      formatVersion: 1, fleurVersion: release.version, bun: release.engines.bun, compiler: "microsoft", project: projectKey(key, project),
      platform: { os: "linux", architecture: ["aarch64", "arm64"].includes(architecture) ? "arm64" : "amd64" },
      images: { archive: archiveName, worker: { tag: tags[0]!, identities: await savedIdentities(join(directory, archiveName), tags[0]!) }, controller: { tag: tags[1]!, identities: await savedIdentities(join(directory, archiveName), tags[1]!) } },
      files,
    };
    const manifest = { ...content, id: artifactIdentity(content) };
    await writeFile(join(directory, manifestName), JSON.stringify(manifest));
    for (const path of [manifestName, ...files.map(file => file.path)]) await chmod(join(directory, path), 0o444);
    const final = resolve(output, manifest.id);
    await rename(directory, final);
    return { id: manifest.id, directory: final, manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { await images?.dispose(); }
}
const buildCodes: Readonly<Record<string, ExitCode>> = { MIGRATIONS_PENDING: 5, MIGRATION_EDITED: 5, SOURCE_REJECTED: 1 };
export async function runBuild(input: CommandInput): Promise<CliOutcome> {
  // Build needs no runtime credential, so none may reach a compiler or Docker child.
  for (const name of Object.keys(process.env)) if (name.startsWith("FLEUR_PRIVATE_") || name === "FLEUR_RETRIEVAL_CREDENTIALS") delete process.env[name];
  let endpoint: string | undefined;
  const prerequisite = await doctor({ args: [], project: input.project, timeoutSeconds: input.timeoutSeconds, json: true }, productionHost(), value => { endpoint = value; });
  if (!prerequisite.result.ok) return { ...prerequisite, result: { ...prerequisite.result, command: "build", data: null } };
  if (!endpoint) return failure("build", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Docker readiness did not identify a local endpoint.", actions: [{ command: "fleur doctor", description: "Inspect prerequisite readiness." }] });
  // Bind every image and worker command to the exact endpoint Doctor qualified.
  process.env.DOCKER_HOST = endpoint; delete process.env.DOCKER_CONTEXT;
  try {
    const { project } = await binding(input.project, false);
    const built = await writeArtifact(await admitProject(project), project, join(project, ".fleur", "artifacts"));
    return success("build", { artifact: built.directory, id: built.id, platform: built.manifest.platform, bytes: built.manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
  } catch (error) {
    if (error instanceof SourceAdmissionError) return failure("build", 1, { code: "SOURCE_REJECTED", message: `${error.diagnostic.file}:${error.diagnostic.line} ${error.diagnostic.code}. ${error.diagnostic.action}`, actions: [{ command: "fleur build", description: "Correct the reported source, then build again." }] });
    const code = error instanceof Error && error.message in buildCodes ? error.message : "INTERNAL_FAILURE";
    return failure("build", buildCodes[code] as Exclude<ExitCode, 0> ?? 1, { code, message: code === "MIGRATIONS_PENDING" ? "The application's declarations differ from its last reviewed migration." : "The artifact could not be built; no partial artifact was published.", actions: [{ command: code === "MIGRATIONS_PENDING" ? "fleur db migration generate" : "fleur doctor", description: code === "MIGRATIONS_PENDING" ? "Generate and review the migration, then build again." : "Inspect prerequisites and retry." }] });
  }
}
