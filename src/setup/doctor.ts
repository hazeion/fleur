import { failure, type CliOutcome } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { SetupHost, HostCommandResult } from "./commands.ts";
import { smokeContainer } from "./smoke.ts";
import { smokeImages, installationMethod } from "./profiles.ts";
/** Endpoint callback stays within trusted prerequisite orchestration, never CLI JSON. */
export async function doctor({ args, timeoutSeconds }: CommandInput, host: SetupHost, localEndpoint?: (endpoint: string) => void): Promise<CliOutcome> {
    if (args.length) return failure("doctor", 2, { code: "ARGUMENT_INVALID", message: "Doctor takes no positional arguments.", actions: [] });
    const deadline = performance.now() + timeoutSeconds * 1000;
    const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
    const run = (args: readonly string[]) => remaining() > 0 ? host.run(args, remaining()) : Promise.resolve<HostCommandResult>({ status: "timeout", stdout: "", stderr: "" });
    const identity = await host.host();
    if (remaining() <= 0) return failure("doctor", 4, { code: "READINESS_TIMEOUT", message: "Prerequisite checks exceeded the operation deadline.", actions: [] });
    if (identity.translated !== false) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Run Fleur through native Bun before setup.", expected: "native execution", actual: identity.translated === true ? "translated execution" : "unknown translation state", actions: [{ command: "fleur doctor", description: "Use native Bun and retry." }] });
    if (!installationMethod(identity)) return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The native operating-system target is outside the supported setup matrix.", actual: "unsupported platform", actions: [] });
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
    const daemon = await run(["docker", "--host", endpoint, "info", "--format", "{{json .}}"]);
    const compose = await run(["docker", "--host", endpoint, "compose", "version", "--short"]);
    let daemonIdentity: { ServerVersion?: unknown; OSType?: unknown; Architecture?: unknown } | null = null;
    try { const value: unknown = JSON.parse(daemon.stdout); if (value !== null && typeof value === "object" && !Array.isArray(value)) daemonIdentity = value; } catch { /* Invalid daemon data is not readiness. */ }
    const daemonCompatible = typeof daemonIdentity?.ServerVersion === "string" && /^\d+\.\d+\.\d+$/.test(daemonIdentity.ServerVersion) && daemonIdentity.OSType === "linux" && (identity.architecture === "x64" ? ["amd64", "x86_64"].includes(String(daemonIdentity.Architecture)) : ["arm64", "aarch64"].includes(String(daemonIdentity.Architecture)));
    const daemonState = daemon.status === "timeout" ? "timeout" : daemon.status !== "completed" || daemon.exitCode !== 0 ? /permission denied|access denied/i.test(daemon.stderr) ? "denied" : "unavailable" : daemonCompatible ? "ready" : "incompatible";
    if (daemonState === "ready") {
      const image = smokeImages[identity.architecture];
      if (image) {
        const imageState = await run(["docker", "--host", endpoint, "image", "inspect", image, "--format", "{{json .}}"]);
        if (imageState.status === "completed" && imageState.exitCode !== 0) return failure("doctor", 3, { code: "AUTHORITY_REQUIRED", message: "The digest-pinned smoke image must be acquired explicitly before readiness can be checked.", actions: [{ command: "fleur setup", description: "Inspect the exact smoke image acquisition plan and required permission." }] }, { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: compose.status === "completed" && compose.exitCode === 0 ? "ready" : "missing" }, smoke: { state: "image-required", image } } });
        if (imageState.status === "completed" && imageState.exitCode === 0) {
          const reserve = Math.min(2000, Math.floor(remaining() / 3));
          const work = (args: readonly string[]) => remaining() > reserve ? host.run(args, remaining() - reserve) : Promise.resolve<HostCommandResult>({ status: "timeout", stdout: "", stderr: "" });
          const smoke = await smokeContainer(work, endpoint, image, imageState.stdout, identity.architecture, run);
          return failure("doctor", smoke.cleanup ? 4 : 5, { code: smoke.cleanup ? "PREREQUISITE_UNAVAILABLE" : "RECOVERY_REQUIRED", message: smoke.cleanup ? "Observed readiness does not yet establish a verified native release profile." : "Owned smoke container cleanup could not be confirmed.", actions: [] }, { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: compose.status === "completed" && compose.exitCode === 0 ? "ready" : "missing" }, smoke: { ...smoke }, release: { state: "unverified" } } });
        }
      }
    }
    return failure("doctor", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Prerequisite readiness requires verified release and smoke evidence.", actions: [{ command: "fleur setup", description: "Inspect the missing actions without replacing existing software." }] }, { components: { cli: { state: "ready", version: cli.stdout.trim() }, daemon: { state: daemonState }, compose: { state: compose.status === "completed" && compose.exitCode === 0 ? "ready" : "missing", version: compose.stdout.trim() }, smoke: { state: "not-checked" } } });
}
