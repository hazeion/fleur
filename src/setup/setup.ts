import { selectNativeProfile, type NativeInstallProfile } from "./native.ts";
import { setupNativeApt } from "./native-apt.ts";
import { installationMethod } from "./profiles.ts";
import { failure, type CliOutcome, type Json } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { SetupHost } from "./commands.ts";
import { doctor } from "./doctor.ts";
import { readGrants, stateDirectory, writeGrants, type Grant } from "./grants.ts";
import { withSetupLock, SetupBusy } from "./lock.ts";
function diagnostic(data: Json): Readonly<Record<string, Json>> { return data !== null && typeof data === "object" && !Array.isArray(data) ? data as Readonly<Record<string, Json>> : {}; }
function reframe(outcome: CliOutcome, extra: Readonly<Record<string, Json>> = {}): CliOutcome { return { ...outcome, result: { ...outcome.result, command: "setup", data: outcome.result.data === null && Object.keys(extra).length === 0 ? null : { ...diagnostic(outcome.result.data), ...extra } } }; }
export async function setup(input: CommandInput, host: SetupHost, profiles: readonly NativeInstallProfile[] = []): Promise<CliOutcome> {
  if (input.args.some((arg, index) => arg !== "--grant" && input.args[index - 1] !== "--grant")) return failure("setup", 2, { code: "ARGUMENT_INVALID", message: "Setup accepts only --grant <id>.", actions: [] });
  const deadline = performance.now() + input.timeoutSeconds * 1000;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const identity = await host.host();
  const method = installationMethod(identity);
  if (identity.translated !== false || !method) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Assisted setup requires a supported native platform.", actions: [{ command: "fleur doctor", description: "Inspect native platform compatibility." }] });
  let endpoint: string | undefined;
  const probe = () => doctor({ ...input, args: [], timeoutSeconds: remaining() / 1000 }, host, (local) => { endpoint = local; });
  const observed = await probe();
  if (observed.result.ok) return reframe(observed);
  const imageNeeded = (outcome: CliOutcome) => outcome.result.error?.code === "AUTHORITY_REQUIRED";
  if (imageNeeded(observed) && endpoint) {
    try {
      return await withSetupLock(stateDirectory(host), async () => {
        const fresh = await probe();
        if (!imageNeeded(fresh) || !endpoint) return reframe(fresh);
        const components = diagnostic(diagnostic(fresh.result.data).components ?? null);
        const image = diagnostic(components.smoke ?? null).image;
        if (typeof image !== "string" || !/^oven\/bun@sha256:[a-f0-9]{64}$/.test(image) || !identity.machineId || !/^[a-f0-9]{64}$/.test(identity.machineId)) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "Image acquisition requires verified machine and artifact identity.", actions: [] });
        const target = `${image} via ${endpoint}`;
        if (target.length > 512) return failure("setup", 4, { code: "PREREQUISITE_UNAVAILABLE", message: "The local acquisition target cannot be safely represented.", actions: [] });
        const scope = { action: "image-acquire", method: "docker-digest-pull", target, machine: identity.machineId, user: process.getuid!() };
        const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(scope), "hex");
        let grants = [...await readGrants(host)];
        const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
        let grant = grants.find((candidate) => (!specified || candidate.id === specified) && !candidate.revoked && candidate.action === scope.action && candidate.method === scope.method && candidate.target === scope.target && candidate.machine === scope.machine && candidate.user === scope.user && candidate.planChecksum === checksum);
        if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
          const decision = await host.confirmHuman({ action: scope.action, method: scope.method, target, checksum }, remaining());
          if (decision === "once" || decision === "remembered") {
            grant = { ...scope, id: crypto.randomUUID(), planChecksum: checksum, mode: decision, revoked: false } satisfies Grant;
            grants.push(grant);
            await writeGrants(host, grants);
          }
        }
        if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "A human must authorize this exact digest acquisition for this local endpoint, or supply its existing grant.", actions: [{ command: "fleur setup", description: "Run interactively to inspect this scoped image acquisition action." }] }, { plan: { action: scope.action, method: scope.method, image, checksum }, resumable: true, grantsCreated: false });
        // Consume once authority durably before any external change. A failure never replays it.
        if (grant.mode === "once") { grants = grants.map((candidate) => candidate.id === grant!.id ? { ...candidate, revoked: true } : candidate); await writeGrants(host, grants); }
        if (remaining() <= 0) return failure("setup", 4, { code: "READINESS_TIMEOUT", message: "Setup deadline expired before image acquisition.", actions: [] });
        const acquired = await host.run(["docker", "--host", endpoint, "pull", image], remaining());
        if (acquired.status !== "completed" || acquired.exitCode !== 0) return failure("setup", acquired.status === "timeout" ? 4 : 1, { code: acquired.status === "timeout" ? "READINESS_TIMEOUT" : "PREREQUISITE_UNAVAILABLE", message: "The explicit smoke image acquisition failed; existing installations were preserved.", actions: [{ command: "fleur setup", description: "Reprobe prerequisites and inspect any still-required acquisition permission." }] }, { setupAction: { action: scope.action, state: "failed" }, resumable: true });
        return reframe(await probe(), { setupAction: { action: scope.action, state: "completed" }, resumable: true });
      }, host.syncDirectory);
    } catch (error) { return failure("setup", 5, { code: error instanceof SetupBusy ? "MAINTENANCE_BUSY" : "RECOVERY_REQUIRED", message: "Setup is blocked by concurrent work or unsafe private state.", actions: [] }); }
  }
  const components = diagnostic(diagnostic(observed.result.data).components ?? null);
  const cli = diagnostic(components.cli ?? null);
  const daemon = diagnostic(components.daemon ?? null);
  const localUnready = endpoint !== undefined && cli.state === "ready" && (daemon.state === "ready" || daemon.state === "unavailable" || daemon.state === "denied");
  const packageInspectionAllowed = observed.exitCode === 4 && observed.result.error?.code === "PREREQUISITE_UNAVAILABLE" && (cli.state === "missing" || localUnready);
  const profile = packageInspectionAllowed ? selectNativeProfile(identity, profiles) : undefined;
  if (profile) return setupNativeApt(input, host, identity, profile, remaining, cli.state === "ready");
  if (cli.state !== "missing") return reframe(observed);
  return failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message: "The official installation method requires a verified release profile and separately authorized machine changes. Existing software was preserved.", actions: [{ command: "fleur doctor", description: "Inspect current prerequisites; complete the documented official setup manually and rerun setup." }] }, { plan: { method, verified: false, actions: ["install", "repository-configuration", "service-start", "service-enable", "docker-access", "profile-configuration", "legal-acceptance"], steps: method === "docker-official-apt" ? [{ action: "repository-configuration", method, state: "unverified" }, { action: "install", method, state: "unverified", requires: ["service-start", "service-enable"] }] : [{ action: "install", method, state: "unverified", requires: method === "docker-desktop-official-dmg" ? ["profile-configuration", "legal-acceptance"] : [] }], reason: "Native installer and side-effect verification is incomplete." }, grantsCreated: false, resumable: true });
}
