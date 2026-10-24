import { readFile, writeFile, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

export type AptGuardFault = "native-dependency-architecture" | "foreign-dependency-architecture" | "duplicate-dependency-alias" | "extra-configure" | "unknown-package" | "existing-version" | "direction" | "target-version" | "configure-before-install" | "duplicate-configure" | "duplicate-install" | "missing-install" | "archive-path-canonical" | "archive-path-different" | "invocation" | "plan-mode" | "plan-json" | "plan-schema" | "protocol-header" | "protocol-config" | "protocol-action" | "package-state" | "archive-identity" | "archive-digest";

/** Executes the actual source-owned hook through a disposable external APT/dpkg fixture. */
export async function aptGuardProtocol(args: readonly string[], packages: Readonly<Record<string, string>>, rows: readonly string[], fault?: AptGuardFault, sink?: "closed" | "full", noDownloadCache = false): Promise<HostCommandResult> {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const directory = await mkdtemp("/tmp/fleur-apt-guard-fixture-");
  try {
    const bin = join(directory, "bin"); await mkdir(bin);
    await writeFile(join(bin, "dpkg-query"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify([...rows, "unrelated-sentinel\\t1\\tinstalled\\tok".replaceAll("\\t", "\t")].join("\n") + "\n")});\n`, { mode: 0o700 });
    let command = args.find((arg) => arg.startsWith("DPkg::Pre-Install-Pkgs::="))?.slice("DPkg::Pre-Install-Pkgs::=".length);
    if (!command) return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; // Models an unguarded ordinary APT invocation.
    const paths = args.slice(args.indexOf("install") + 1);
    const actions = paths.flatMap((path) => {
      const name = basename(path).split("_")[0]!;
      if (!Object.hasOwn(packages, name)) throw new Error("Unexpected fixture archive action");
      let selected = path;
      if (noDownloadCache) {
        const cache = args.find((arg) => arg.startsWith("Dir::Cache::Archives="))?.slice("Dir::Cache::Archives=".length);
        const filename = `${name}_${packages[name]!.replaceAll(":", "%3a").replaceAll("_", "%5f")}_amd64.deb`;
        const final = cache ? join(cache, filename) : undefined;
        selected = final && Bun.file(final).size === aptFixtureArtifacts(packages)[name as keyof AptInstallProfile["artifacts"]]!.size ? final : "**ERROR**";
      }
      return [`${name} - < ${packages[name]} ${selected}`, `${name} - < ${packages[name]} **CONFIGURE**`];
    });
    if (fault === "native-dependency-architecture" || fault === "foreign-dependency-architecture" || fault === "duplicate-dependency-alias") {
      for (let index = 0; index < actions.length; index++) {
        if (!/^(libjansson4|libnftables1) /.test(actions[index]!)) continue;
        const qualified = actions[index]!.replace(/^(\S+)/, `$1:${fault === "foreign-dependency-architecture" ? "arm64" : "amd64"}`);
        if (fault === "duplicate-dependency-alias") { actions.splice(index + 1, 0, qualified); break; }
        actions[index] = qualified;
      }
    }
    if (fault === "extra-configure") actions.push("foreign-package - < 1 **CONFIGURE**");
    if (fault === "unknown-package") actions[0] = actions[0]!.replace(/^\S+/, "PRIVATE-SENTINEL");
    if (fault === "existing-version") actions[0] = actions[0]!.replace(" - < ", " 0 < ");
    if (fault === "direction") actions[0] = actions[0]!.replace(" - < ", " - > ");
    if (fault === "target-version") actions[0] = actions[0]!.replace(/ - < \S+ /, " - < 99 ");
    if (fault === "configure-before-install") [actions[0], actions[1]] = [actions[1]!, actions[0]!];
    if (fault === "duplicate-configure") actions.splice(2, 0, actions[1]!);
    if (fault === "duplicate-install") actions.splice(1, 0, actions[0]!);
    if (fault === "missing-install") actions.splice(-2);
    if (fault === "archive-path-canonical") actions[0] = actions[0]!.replace(paths[0]!, dirname(paths[0]!) + "/./" + basename(paths[0]!));
    if (fault === "archive-path-different") actions[0] = actions[0]!.replace(paths[0]!, "/PRIVATE-SENTINEL\u001b[31m.deb");
    let protocol = "VERSION 2\nRootDir=/\nDir::State::status=/var/lib/dpkg/status\nDebug::NoLocking=false\n\n" + actions.join("\n") + "\n";
    const env = { PATH: bin, APT_HOOK_INFO_FD: "0", DPKG_FRONTEND_LOCKED: "true" };
    if (fault === "invocation") env.APT_HOOK_INFO_FD = "PRIVATE-SENTINEL\n\u001b[31m";
    if (fault === "protocol-header") protocol = protocol.replace("VERSION 2", "PRIVATE-SENTINEL\u001b[31m");
    if (fault === "protocol-config") protocol = protocol.replace("RootDir=/", "RootDir=%PRIVATE-SENTINEL");
    if (fault === "protocol-action") protocol += "PRIVATE-SENTINEL\u001b[31m\n";
    if (fault === "package-state") await writeFile(join(bin, "dpkg-query"), `#!${process.execPath}\nprocess.stdout.write('docker-ce\\t1\\tinstalled\\tok\\n');\n`, { mode: 0o700 });
    if (fault === "archive-identity") await writeFile(paths[0]!, "PRIVATE-SENTINEL");
    if (fault === "archive-digest") { const bytes = await readFile(paths[0]!); bytes[0] = 88; await writeFile(paths[0]!, bytes); }
    const plan = join(dirname(dirname(paths[0]!)), "apt-plan.json");
    const original = fault?.startsWith("plan-") ? await readFile(plan) : undefined;
    if (fault === "plan-mode") await chmod(plan, 0o644);
    if (fault === "plan-json" || fault === "plan-schema") {
      const altered = Buffer.from(fault === "plan-json" ? "PRIVATE-SENTINEL\n\u001b[31m" : '{"private":"PRIVATE-SENTINEL"}');
      await writeFile(plan, altered);
      command = command.replace(Bun.CryptoHasher.hash("sha256", original!, "hex"), Bun.CryptoHasher.hash("sha256", altered, "hex"));
    }
    if (sink) {
      const gate = join(directory, "release"); const witness = join(directory, "fill-witness");
      // This owned wrapper fills/closes only the diagnostic sink before executing the real hook.
      const wrapper = `process.stderr.write('OWNED GUARD PIPE\\n');if(${sink === "full"}){const {writeSync}=await import('node:fs');let errorCode=null;for(let i=0;i<1000;i++){try{writeSync(2,Buffer.alloc(4096,120));}catch(error){errorCode=error.code;break;}}await Bun.write(${JSON.stringify(witness)},JSON.stringify({errorCode}));}const deadline=Date.now()+3000;while(!await Bun.file(${JSON.stringify(gate)}).exists()){if(Date.now()>deadline)process.exit(124);await Bun.sleep(5);}const child=Bun.spawn(['/bin/sh','-c',${JSON.stringify(command)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`;
      const child = Bun.spawn([process.execPath, "--eval", wrapper], { env, stdin: Buffer.from(protocol), stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL" });
      const reader = child.stderr.getReader();
      if (!new TextDecoder().decode((await reader.read()).value).includes("OWNED GUARD PIPE")) throw new Error("Missing owned pipe ordering witness");
      if (sink === "closed") await reader.cancel();
      await writeFile(gate, "release", { flag: "wx" });
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (sink === "full") { await reader.cancel(); if (JSON.parse(await readFile(witness, "utf8")).errorCode !== "EAGAIN") throw new Error("Diagnostic pipe did not reach EAGAIN"); }
      if (exitCode !== 1) throw new Error(`Guard refusal exit changed with ${sink} pipe: ${exitCode}`);
      return { status: "completed", exitCode: 100, stdout, stderr: "" };
    }
    const guard = Bun.spawn(["/bin/sh", "-c", command], { env, stdin: Buffer.from(protocol), stdout: "pipe", stderr: "pipe", timeout: 6000, killSignal: "SIGKILL" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(guard.stdout).text(), new Response(guard.stderr).text(), guard.exited]);
    if (original) { await writeFile(plan, original); await chmod(plan, 0o600); }
    return { status: "completed", exitCode: exitCode === 0 ? 0 : 100, stdout, stderr };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function aptFixturePackageTargets(args: readonly string[], packages: Readonly<Record<string, string>>): string[] {
  const artifacts = aptFixtureArtifacts(packages);
  return args.slice(args.indexOf("install") + 1).map((entry) => {
    const exact = Object.entries(packages).find(([name, version]) => entry === `${name}=${version}`);
    if (exact) return `${exact[0]}=${exact[1]}`;
    const artifact = Object.values(artifacts).find((candidate) => basename(entry) === new URL(candidate.url).pathname.split("/").at(-1) || basename(entry) === `${candidate.name}_${candidate.version.replaceAll(":", "%3a").replaceAll("_", "%5f")}_${candidate.architecture}.deb`);
    if (!entry.startsWith("/") || !artifact) throw new Error("Unadmitted fixture local archive");
    return `${artifact.name}=${artifact.version}`;
  });
}

export function aptHealthProtocol(args: readonly string[], rows: readonly string[] = []): HostCommandResult | undefined {
  if (args[0] !== "dpkg-query" || args.length !== 5 || !args.includes("--show")) return undefined;
  return { status: "completed", exitCode: 0, stdout: [...rows, "unrelated-sentinel\t1\tinstalled\tok"].join("\n") + "\n", stderr: "" };
}
