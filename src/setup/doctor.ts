import { nativeReadinessProfiles, snapshotReadinessProfiles, compareReadiness, matchReadinessServer, sameReadinessDaemon, type MachineToolComparison, type ReadinessComparison, type VerifiedReadinessProfile } from "./readiness.ts";
import { hasPendingLinuxAccess } from "./access-pending.ts";
import { hasPendingPackageTransaction } from "./package-pending.ts";
import { hasPendingArchService, hasPendingAptService } from "./service-pending.ts";
import { observeEndpointActivation } from "./activation-observer.ts";
import { validateSetupArguments } from "./syntax.ts";
import { failure, success, type CliOutcome, type CommandError, type Json } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { SetupHost, HostCommandResult } from "./commands.ts";
import { smokeContainer } from "./smoke.ts";
import { smokeImages, installationMethod } from "./profiles.ts";

type Components = Readonly<Record<string, { readonly state: string; readonly cleanup?: boolean }>>;
const floorAction = { command: "fleur setup", description: "Inspect the missing actions without replacing existing software." };
/** Refusal wording decided in #131: the tool and both numbers for an older version, the build for a pre-release, nothing more for a release-less tool. */
function floorRefusal({ tool, floor, detected, comparison }: MachineToolComparison): CommandError {
  const message = comparison === "older" ? `Machine tool ${tool} is ${detected}, below the floor ${floor}.`
    : comparison === "pre-release" ? `Machine tool ${tool} is a pre-release build (${detected}); release floors admit stable versions only.`
    : `Machine tool ${tool} has no parseable version.`;
  return { code: "PREREQUISITE_UNAVAILABLE", message, expected: { tool, floor }, actual: { tool, detected }, actions: [floorAction] };
}
function toolRows(rows: readonly MachineToolComparison[]): Json[] { return rows.map(({ tool, status, floor, detected, comparison }) => ({ tool, status, floor, detected, comparison })); }
function toolLine({ tool, status, floor, detected, comparison }: MachineToolComparison): string {
  const relation = comparison === "equal" ? "= floor" : comparison === "newer" ? `> floor ${floor}` : comparison === "older" ? `< floor ${floor}` : comparison === "pre-release" ? "pre-release, not admitted" : `no parseable version (floor ${floor})`;
  return `            ${tool.padEnd(11)} ${status.padEnd(10)}  ${(detected ?? "none").padEnd(24)} ${relation}`;
}
/** Human text with the status word beside every machine tool (#131 Variant A); a refusal ends with its message and action. */
function renderReadiness(components: Components, comparison: ReadinessComparison, error?: CommandError): string {
  const lines = ["cli", "daemon", "compose"].map((name) => `  ${name.padEnd(10)}${components[name]?.state ?? "unknown"}`);
  lines.push(`  ${"smoke".padEnd(10)}${components.smoke?.state ?? "unknown"}${components.smoke?.cleanup ? ", cleanup confirmed" : ""}`);
  const admitted = comparison.machineTools.filter((row) => row.status === "admitted").length;
  if (error) {
    lines.push(`  ${"release".padEnd(10)}unverified  floor ${comparison.floor}`);
    for (const row of comparison.machineTools.filter((row) => row.status === "unverified")) lines.push(toolLine(row));
    for (const row of comparison.machineTools.filter((row) => row.status !== "unverified")) lines.push(toolLine(row));
    lines.push("", `${error.code}: ${error.message}`, ...error.actions.map((action) => `  ${action.command}   ${action.description}`));
  } else {
    lines.push(`  ${"release".padEnd(10)}verified  floor ${comparison.floor} (measured on ${comparison.measuredRows.join(", ")})`);
    for (const row of comparison.machineTools) lines.push(toolLine(row));
    if (comparison.admission === "above-floor") lines.push(admitted ? `            ${admitted} tool${admitted === 1 ? "" : "s"} admitted above the measured baseline; measured evidence is for the baseline tuple.` : "            No single measured row matches this tuple; measured evidence is for the baseline tuple.");
  }
  return lines.join("\n") + "\n";
}

/** Endpoint callback stays within trusted prerequisite orchestration, never CLI JSON. */
export async function doctor({ args, timeoutSeconds }: CommandInput, host: SetupHost, localEndpoint?: (endpoint: string) => void, readinessProfiles: readonly VerifiedReadinessProfile[] = nativeReadinessProfiles, artifactImage?: (endpoint: string) => Promise<string>): Promise<CliOutcome> {
    const invalid = validateSetupArguments("doctor", args);
    if (invalid) return invalid;
    const deadline = performance.now() + timeoutSeconds * 1000;
    const policy = snapshotReadinessProfiles(readinessProfiles);
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    const run = (args: readonly string[]) => remaining() > 0 ? host.run(args, remaining()) : Promise.resolve<HostCommandResult>({ status: "timeout", stdout: "", stderr: "" });
    const identity = await host.host();
    if (remaining() <= 0) return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Prerequisite checks exceeded the operation deadline.", actions: [] });
    if (identity.translated !== false) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Run Fleur through native Bun before setup.", expected: "native execution", actual: identity.translated === true ? "translated execution" : "unknown translation state", actions: [{ command: "fleur doctor", description: "Use native Bun and retry." }] });
    if (!installationMethod(identity)) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The native operating-system target is outside the supported setup matrix.", actual: "unsupported platform", actions: [] });
    if (await hasPendingPackageTransaction(host, identity)) return failure("doctor", 5, { code: "RECOVERY_REQUIRED", message: "An earlier privileged package transaction is unresolved. Its pending state and private artifacts were preserved; inspect the transaction before resuming setup.", actions: [] });
    const cli = await run(["docker", "--version"]);
    if (cli.status === "timeout") return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Docker CLI did not finish within the operation deadline.", actions: [] });
    if (cli.status === "missing") return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Docker CLI is missing.", actions: [{ command: "fleur setup", description: "Inspect prerequisite setup actions." }] }, { components: { cli: { state: "missing" } } });
    if (cli.status !== "completed" || cli.exitCode !== 0) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Docker CLI is unavailable.", actions: [] });
    let endpoint: string;
    const context = await run(["docker", "context", "show"]);
    if (context.status !== "completed" || context.exitCode !== 0 || !context.stdout.trim()) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Docker context cannot be resolved.", actions: [] });
    const selected = context.stdout.trim();
    if (host.environment?.DOCKER_HOST && !host.environment.DOCKER_CONTEXT) endpoint = host.environment.DOCKER_HOST;
    else {
      const inspected = await run(["docker", "context", "inspect", selected, "--format", "{{json .Endpoints.docker}}"]);
      try { endpoint = JSON.parse(inspected.stdout).Host; } catch { endpoint = ""; }
    }
    if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///") || endpoint.length <= 8 || endpoint.length > 4096 || [...endpoint].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || /[?#]/.test(endpoint) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(endpoint)) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "A local Unix Docker endpoint is required; global context was preserved.", actual: typeof endpoint === "string" && endpoint && !endpoint.startsWith("unix:") ? "remote endpoint" : "malformed endpoint", actions: [{ command: "fleur doctor", description: "Select an existing compatible local endpoint outside Fleur and retry." }] });
    localEndpoint?.(endpoint);
    if (["arch", "ubuntu", "debian"].includes(identity.distribution ?? "") && ["unix:///run/docker.sock", "unix:///var/run/docker.sock"].includes(endpoint) && await hasPendingLinuxAccess(host)) return failure("doctor", 5, { code: "RECOVERY_REQUIRED", message: "An earlier Docker access operation is unresolved. Its pending state was preserved; no daemon RPC was sent.", actions: [] });
    if (identity.distribution === "arch" && ["unix:///run/docker.sock", "unix:///var/run/docker.sock"].includes(endpoint) && await hasPendingArchService(host)) return failure("doctor", 5, { code: "RECOVERY_REQUIRED", message: "An earlier privileged service operation is unresolved. Its pending state was preserved; no daemon RPC was sent.", actions: [] });
    if (["ubuntu", "debian"].includes(identity.distribution ?? "") && ["unix:///run/docker.sock", "unix:///var/run/docker.sock"].includes(endpoint) && await hasPendingAptService(host)) return failure("doctor", 5, { code: "RECOVERY_REQUIRED", message: "An earlier privileged service operation is unresolved. Its pending state was preserved; no daemon RPC was sent.", actions: [] });
    if (["arch", "ubuntu", "debian"].includes(identity.distribution ?? "")) {
      const activation = await observeEndpointActivation(host, remaining, endpoint);
      if (activation.state !== "clear") return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: activation.state === "activation-needed" ? "The selected socket would activate a stopped service. Separate startup authority is required before contacting it." : "The selected socket's activation owner could not be observed safely; no daemon RPC was sent.", actions: [{ command: "fleur setup", description: "Inspect the exact service action or resolve unknown activation ownership." }] }, { components: { cli: { state: "ready" }, daemon: { state: "unavailable" }, service: activation } });
    }
    const daemon = await run(["docker", "--host", endpoint, "info", "--format", "{{json .}}"]);
    const compose = await run(["docker", "--host", endpoint, "compose", "version", "--short"]);
    let daemonIdentity: { ServerVersion?: unknown; OSType?: unknown; Architecture?: unknown } | null = null;
    try { const value: unknown = JSON.parse(daemon.stdout); if (value !== null && typeof value === "object" && !Array.isArray(value)) daemonIdentity = value; } catch { /* Invalid daemon data is not readiness. */ }
    const daemonCompatible = typeof daemonIdentity?.ServerVersion === "string" && /^\d+\.\d+\.\d+$/.test(daemonIdentity.ServerVersion) && daemonIdentity.OSType === "linux" && (identity.architecture === "x64" ? ["amd64", "x86_64"].includes(String(daemonIdentity.Architecture)) : ["arm64", "aarch64"].includes(String(daemonIdentity.Architecture)));
    const daemonState = daemon.status === "timeout" ? "timeout" : daemon.status !== "completed" || daemon.exitCode !== 0 ? /permission denied|access denied/i.test(daemon.stderr) ? "denied" : "unavailable" : daemonCompatible ? "ready" : "incompatible";
    if (daemonState === "ready") {
      const image = smokeImages[identity.architecture];
      if (image) {
        // A production artifact proves the boundary with its own exact image, so
        // start needs no acquired smoke image. Profiles still compare the pin.
        const probe = artifactImage ? await artifactImage(endpoint) : image;
        const imageState = await run(["docker", "--host", endpoint, "image", "inspect", probe, "--format", "{{json .}}"]);
        if (imageState.status === "completed" && imageState.exitCode !== 0) return failure("doctor", 3, { code: "AUTHORITY_REQUIRED", message: "The digest-pinned smoke image must be acquired explicitly before readiness can be checked.", actions: [{ command: "fleur setup", description: "Inspect the exact smoke image acquisition plan and required permission." }] }, { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: compose.status === "completed" && compose.exitCode === 0 ? "ready" : "missing" }, smoke: { state: "image-required", image } } });
        if (imageState.status === "completed" && imageState.exitCode === 0) {
          const reserve = Math.min(2000, Math.floor(remaining() / 3));
          const work = (args: readonly string[]) => remaining() > reserve ? host.run(args, remaining() - reserve) : Promise.resolve<HostCommandResult>({ status: "timeout", stdout: "", stderr: "" });
          const smoke = await smokeContainer(work, endpoint, probe, imageState.stdout, identity.architecture, run, artifactImage !== undefined);
          const components = { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: compose.status === "completed" && compose.exitCode === 0 ? "ready" : "missing" }, smoke: { ...smoke }, release: { state: "unverified" } };
          const observation = { identity, cli: cli.stdout, compose: compose.stdout, image, info: daemonIdentity };
          // Identity facts gate the remaining RPC: a host matching no measured row keeps the generic refusal without a version query.
          if (smoke.state === "ready" && smoke.cleanup && compose.status === "completed" && compose.exitCode === 0 && policy.length && compareReadiness(policy, { ...observation, bun: Bun.version, server: undefined }).identity.matched) {
            // Bun.version hides a canary or debug tag; only the executable's own --revision shows it.
            const revision = await run([process.execPath, "--no-env-file", "--revision"]);
            if (revision.status === "timeout" || remaining() <= 0) return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Bun revision did not finish within the operation deadline.", actions: [] }, { components });
            const bun = { version: Bun.version, revision: revision.status === "completed" && revision.exitCode === 0 ? revision.stdout.trim() : "" };
            const version = await run(["docker", "--host", endpoint, "version", "--format", "{{json .Server}}"]);
            if (version.status === "timeout" || remaining() <= 0) return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Runtime qualification exceeded the operation deadline.", actions: [] }, { components });
            let server: unknown;
            try { server = version.status === "completed" && version.exitCode === 0 ? JSON.parse(version.stdout) : undefined; } catch { server = undefined; }
            if (server !== undefined) {
              const comparison = compareReadiness(policy, { ...observation, bun, server });
              if (comparison.state === "verified") {
                // Evidence comes from the measured row of this target that the server build matches exactly, else the target's first row.
                const profile = matchReadinessServer(policy.filter((row) => comparison.measuredRows.includes(row.id)), identity, server);
                const final = await run(["docker", "--host", endpoint, "info", "--format", "{{json .}}"]);
                if (final.status === "timeout" || remaining() <= 0) return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Final daemon identity exceeded the operation deadline.", actions: [] }, { components });
                let observed: unknown;
                try { observed = final.status === "completed" && final.exitCode === 0 ? JSON.parse(final.stdout) : undefined; } catch { observed = undefined; }
                const unchanged = sameReadinessDaemon(daemonIdentity, observed);
                if (remaining() <= 0) return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Final daemon metadata validation exceeded the operation deadline.", actions: [] }, { components });
                if (profile && unchanged) {
                  const release = { state: "verified", floor: comparison.floor, admission: comparison.admission, measuredRows: [...comparison.measuredRows], machineTools: toolRows(comparison.machineTools), evidence: { ...profile.evidence } };
                  return { ...success("doctor", { components: { ...components, release } }), human: renderReadiness(components, comparison) };
                }
              } else if (comparison.blocking) {
                const error = floorRefusal(comparison.blocking);
                return { ...failure("doctor", 4, error, { components: { ...components, release: { state: "unverified", floor: comparison.floor, machineTools: toolRows(comparison.machineTools) } } }), human: renderReadiness(components, comparison, error) };
              }
            }
          }
          return failure("doctor", smoke.cleanup ? 4 : 5, { code: smoke.cleanup ? "PREREQUISITE_UNAVAILABLE" : "RECOVERY_REQUIRED", message: smoke.cleanup ? "Observed readiness does not yet establish a verified native release profile." : "Owned smoke container cleanup could not be confirmed.", actions: [] }, { components });
        }
      }
    }
    return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Prerequisite readiness requires verified release and smoke evidence.", actions: [{ command: "fleur setup", description: "Inspect the missing actions without replacing existing software." }] }, { components: { cli: { state: "ready", version: cli.stdout.trim() }, daemon: { state: daemonState }, compose: { state: compose.status === "completed" && compose.exitCode === 0 ? "ready" : "missing", version: compose.stdout.trim() }, smoke: { state: "not-checked" } } });
}
