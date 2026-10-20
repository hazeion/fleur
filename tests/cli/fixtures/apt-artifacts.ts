import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AptInstallProfile } from "../../../src/setup/native.ts";
import type { HostCommandResult } from "../../../src/setup/commands.ts";

export const aptFixtureBytes = (name: string, version: string, architecture = "amd64") => Buffer.from(`disposable-deb-control:${name}:${version}:${architecture}\ndisposable-application-payload-0000\n`);
export function aptFixtureArtifacts(packages: Readonly<Record<string, string>>, architecture: "amd64" | "arm64" = "amd64"): AptInstallProfile["artifacts"] {
  return Object.fromEntries(Object.entries(packages).map(([name, version]) => {
    const bytes = aptFixtureBytes(name, version, architecture);
    return [name, { name, version, architecture, url: `https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/${architecture}/${name}_${version.replace(/^[0-9]+:/, "")}_${architecture}.deb`, sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"), size: bytes.length }];
  })) as AptInstallProfile["artifacts"];
}
/** Disposable external apt/dpkg-deb protocol fixture, not a production helper mock. */
export async function aptArtifactProtocol(args: readonly string[], context: { readonly cwd?: string } | undefined, packages: Readonly<Record<string, string>>, tamper = false, apt283Wire = false): Promise<HostCommandResult | undefined> {
  const done = (stdout = "") => ({ status: "completed" as const, exitCode: 0, stdout, stderr: "" });
  const artifacts = aptFixtureArtifacts(packages);
  if (args[0] === "apt-get" && args.includes("download")) {
    const target = args.at(-1)!;
    const separator = target.indexOf("=");
    const name = target.slice(0, separator);
    const version = target.slice(separator + 1);
    const artifact = artifacts[name as keyof typeof artifacts];
    if (!artifact || version !== artifact.version) throw new Error("Unadmitted fixture artifact");
    const filename = apt283Wire ? `${name}_${version.replaceAll(":", "%3a")}_amd64.deb` : new URL(artifact.url).pathname.split("/").at(-1)!;
    const uri = apt283Wire ? artifact.url.replaceAll("~", "%7e").replaceAll("+", "%2b") : artifact.url;
    if (args.includes("--print-uris")) return done(`'${uri}' ${filename} ${artifact.size} SHA256:${artifact.sha256}\n`);
    if (!context?.cwd) throw new Error("APT downloads require their owned operation cwd");
    const bytes = aptFixtureBytes(name, version);
    if (tamper) bytes[bytes.length - 2] = bytes[bytes.length - 2] === 48 ? 49 : 48;
    await writeFile(join(context.cwd, filename), bytes, { flag: "wx", mode: 0o600 });
    return done();
  }
  if (args[0] === "dpkg-deb") {
    const name = basename(args[2]!).split("_")[0]!;
    const artifact = artifacts[name as keyof typeof artifacts];
    if (!artifact) throw new Error("Unknown fixture control metadata request");
    return done(`Package: ${name}\nVersion: ${artifact.version}\nArchitecture: ${artifact.architecture}\n`);
  }
  return undefined;
}

/** Executes the actual source-owned hook through a disposable external APT/dpkg fixture. */
export async function aptGuardProtocol(args: readonly string[], packages: Readonly<Record<string, string>>, rows: readonly string[]): Promise<HostCommandResult> {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-apt-guard-fixture-");
  try {
    const bin = join(directory, "bin"); await mkdir(bin);
    await writeFile(join(bin, "dpkg-query"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify([...rows, "unrelated-sentinel\\t1\\tinstalled\\tok".replaceAll("\\t", "\t")].join("\n") + "\n")});\n`, { mode: 0o700 });
    const command = args.find((arg) => arg.startsWith("DPkg::Pre-Install-Pkgs::="))?.slice("DPkg::Pre-Install-Pkgs::=".length);
    if (!command) return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; // Models an unguarded ordinary APT invocation.
    const paths = args.slice(args.indexOf("install") + 1);
    const actions = paths.flatMap((path) => {
      const name = basename(path).split("_")[0]!;
      if (!Object.hasOwn(packages, name)) throw new Error("Unexpected fixture archive action");
      return [`${name} - < ${packages[name]} ${path}`, `${name} - < ${packages[name]} **CONFIGURE**`];
    });
    const protocol = "VERSION 2\nRootDir=/\nDir::State::status=/var/lib/dpkg/status\nDebug::NoLocking=false\n\n" + actions.join("\n") + "\n";
    const guard = Bun.spawn(["/bin/sh", "-c", command], { env: { PATH: bin, APT_HOOK_INFO_FD: "0", DPKG_FRONTEND_LOCKED: "true" }, stdin: Buffer.from(protocol), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(guard.stdout).text(), new Response(guard.stderr).text(), guard.exited]);
    return { status: "completed", exitCode: exitCode === 0 ? 0 : 100, stdout, stderr };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function aptFixturePackageTargets(args: readonly string[], packages: Readonly<Record<string, string>>): string[] {
  const artifacts = aptFixtureArtifacts(packages);
  return args.slice(args.indexOf("install") + 1).map((entry) => {
    const exact = Object.entries(packages).find(([name, version]) => entry === `${name}=${version}`);
    if (exact) return `${exact[0]}=${exact[1]}`;
    const artifact = Object.values(artifacts).find((candidate) => basename(entry) === new URL(candidate.url).pathname.split("/").at(-1));
    if (!entry.startsWith("/") || !artifact) throw new Error("Unadmitted fixture local archive");
    return `${artifact.name}=${artifact.version}`;
  });
}

export function aptHealthProtocol(args: readonly string[], rows: readonly string[] = []): HostCommandResult | undefined {
  if (args[0] !== "dpkg-query" || args.length !== 5 || !args.includes("--show")) return undefined;
  return { status: "completed", exitCode: 0, stdout: [...rows, "unrelated-sentinel\t1\tinstalled\tok"].join("\n") + "\n", stderr: "" };
}
