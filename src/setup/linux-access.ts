import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { accessPendingPath } from "./access-pending.ts";
import { stateDirectory } from "./grants.ts";
import { syncStateDirectory } from "./lock.ts";
import { readGrants, writeGrants, type Grant } from "./grants.ts";
import { failure, type CliOutcome } from "../cli/result.ts";
import type { CommandInput } from "../cli/catalog.ts";
import type { HostIdentity, SetupHost } from "./commands.ts";
import { observeLinuxService, serviceObservation, type LinuxServicePolicy } from "./linux-service.ts";
import { observeEndpointActivation } from "./activation-observer.ts";
/** Called only under the setup lock after exact installed-state and daemon-denial observation. */
export async function setupLinuxAccess(input: CommandInput, host: SetupHost, identity: HostIdentity, policy: LinuxServicePolicy, remaining: () => number, endpoint: string): Promise<CliOutcome> {
  const manual = (message: string, state = "manual") => failure("setup", 3, { code: "HUMAN_ACTION_REQUIRED", message, actions: [] }, { access: { state }, resumable: true });
  const pending = accessPendingPath(host);
  let uncertain = false;
  try {
    try { await lstat(pending); return failure("setup", 5, { code: "RECOVERY_REQUIRED", message: "An earlier access change has an unresolved outcome. No authority was replayed.", actions: [] }); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
    const inspect = async () => {
    if (!process.getuid?.() || !["unix:///run/docker.sock", "unix:///var/run/docker.sock"].includes(endpoint)) throw new Error("Ordinary local user and standard endpoint required");
    if (endpoint === "unix:///var/run/docker.sock" && (await serviceObservation(host, remaining, ["/usr/bin/readlink", "--canonicalize-existing", "/var/run"])).trim() !== "/run") throw new Error("Socket alias differs");
    const activation = await observeEndpointActivation(host, remaining, endpoint);
    if (activation.state !== "clear") throw new Error("Activation unresolved");
    const observed = await observeLinuxService(host, remaining, policy);
    if (Object.values(observed).some((value) => value.ActiveState !== "active")) throw new Error("Services are not active");
    await policy.provenance(host, remaining);
    const localUser = (await serviceObservation(host, remaining, ["/usr/bin/getent", "--service=files", "passwd", String(process.getuid!())])).trim();
    const user = localUser.split(":");
    if (user.length !== 7 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user[0]!) || Number(user[2]) !== process.getuid!() || Number(user[2]) === 0 || (await serviceObservation(host, remaining, ["/usr/bin/getent", "passwd", user[0]!])).trim() !== localUser) throw new Error("User identity is not an unambiguous local account");
    const localGroup = (await serviceObservation(host, remaining, ["/usr/bin/getent", "--service=files", "group", "docker"])).trim();
    const group = localGroup.split(":");
    if (group.length !== 4 || group[0] !== "docker" || !Number.isSafeInteger(Number(group[2])) || Number(group[2]) > 4294967294 || !/^[1-9][0-9]*$/.test(group[2]!) || (await serviceObservation(host, remaining, ["/usr/bin/getent", "group", "docker"])).trim() !== localGroup) throw new Error("Group identity is not an unambiguous local group");
    const socket = (await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%d|%i|%F|%u|%g|%a", "--", "/run/docker.sock"])).trim();
    if (!new RegExp(`^[0-9]+\\|[0-9]+\\|socket\\|0\\|${group[2]}\\|660$`).test(socket)) throw new Error("Socket identity does not match the Docker group");
    const groups = async (args: readonly string[]) => { const output = (await serviceObservation(host, remaining, args)).trim(); if (!/^[0-9]+(?: [0-9]+)*$/.test(output)) throw new Error("Group inventory unavailable"); return output.split(" "); };
    const accountGroups = await groups(["/usr/bin/id", "--groups", "--", user[0]!]);
    const sessionGroups = await groups(["/usr/bin/id", "--groups"]);
    return { user, group, socket, accountGroups, sessionGroups, observed };
    };
    const actual = await inspect();
    const { user, group, socket, accountGroups, sessionGroups } = actual;
    if (accountGroups.includes(group[2]!)) {
      if (!sessionGroups.includes(group[2]!)) return manual("Docker group membership is already enrolled. Log out and start a new login session, then rerun Fleur. No membership change was repeated.", "new-login-required");
      return manual("This session already has Docker group membership but the daemon denied access. Inspect OS access policy; enrollment was not repeated.");
    }
    const plan = { action: "docker-access", method: policy.method, privilege: "root-equivalent daemon access", user: { name: user[0]!, uid: process.getuid!() }, group: { name: "docker", gid: Number(group[2]) }, socket, endpoint, profile: policy.binding, memberships: accountGroups, units: actual.observed };
    const checksum = Bun.CryptoHasher.hash("sha256", JSON.stringify(plan), "hex");
    const target = `Add ${user[0]} to Docker group ${group[2]}: root-equivalent daemon access; plan ${checksum}`;
    const specified = input.args[0] === "--grant" ? input.args[1] : undefined;
    const matches = (grant: Grant) => (!specified || grant.id === specified) && !grant.revoked && grant.action === "docker-access" && grant.method === policy.method && grant.target === target && grant.planChecksum === checksum && grant.machine === identity.machineId && grant.user === process.getuid!();
    let grants = [...await readGrants(host)]; let grant = grants.find(matches);
    if (!grant && !specified && !input.json && host.interactive && host.confirmHuman) {
      const decision = await host.confirmHuman({ action: "docker-access", method: policy.method, target, checksum }, remaining());
      if (decision === "once" || decision === "remembered") { grant = { id: crypto.randomUUID(), action: "docker-access", method: policy.method, target, planChecksum: checksum, machine: identity.machineId!, user: process.getuid!(), mode: decision, revoked: false }; grants.push(grant); await writeGrants(host, grants); }
    }
    if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "Adding this user to the Docker group grants root-equivalent daemon access and needs separate human authorization.", actions: [] }, { plan: { action: plan.action, method: plan.method, privilege: plan.privilege, user: plan.user, group: plan.group, endpoint, checksum, target }, resumable: true });
    if (sessionGroups.includes(group[2]!)) return manual("Account and current session groups disagree; inspect local account policy manually.");
    if (JSON.stringify(await inspect()) !== JSON.stringify(actual)) throw new Error("Access identity changed after authorization");
    if ((await serviceObservation(host, remaining, ["/usr/bin/stat", "--format=%F|%u|%a|%h", "--", "/usr/sbin/usermod"])).trim() !== "regular file|0|755|1" || (await serviceObservation(host, remaining, ["/usr/bin/dpkg-query", "--root=/", "--admindir=/var/lib/dpkg", "--search", "--", "/usr/sbin/usermod"])).trim() !== "passwd: /usr/sbin/usermod") throw new Error("Membership tool ownership differs");
    grants = [...await readGrants(host)]; grant = grants.find(matches);
    if (!grant) return failure("setup", 3, { code: "AUTHORITY_REQUIRED", message: "The selected Docker access authority changed before enrollment.", actions: [] });
    if (grant.mode === "once") await writeGrants(host, grants.map((value) => value.id === grant!.id ? { ...value, revoked: true } : value));
    const marker = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    uncertain = true;
    try { await marker.writeFile(JSON.stringify({ formatVersion: 1, checksum })); await marker.sync(); } finally { await marker.close(); }
    const sync = () => (host.syncDirectory ?? syncStateDirectory)(stateDirectory(host));
    await sync();
    if (remaining() <= 0) throw new Error("Enrollment deadline");
    const outcome = await host.run(["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "docker", "--", user[0]!], remaining());
    if (outcome.status !== "completed" || outcome.terminationUnconfirmed) throw new Error("Membership outcome is uncertain");
    const after = await inspect();
    // Only this user's addition to the one Docker group may change.
    const stable = (value: typeof actual) => JSON.stringify({ ...value, group: value.group.slice(0, 3), accountGroups: [] });
    if (stable(after) !== stable(actual)) throw new Error("Access identity changed during enrollment");
    const beforeMembers = group[3]!.split(",").filter(Boolean).sort();
    const afterMembers = after.group[3]!.split(",").filter(Boolean).sort();
    const expectedMembers = [...new Set([...beforeMembers, user[0]!])].sort();
    const groupsEqual = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const enrolled = after.accountGroups.includes(group[2]!);
    if (enrolled ? !groupsEqual(after.accountGroups, [...accountGroups, group[2]!]) || !groupsEqual(afterMembers, expectedMembers) : !groupsEqual(after.accountGroups, accountGroups) || !groupsEqual(afterMembers, beforeMembers)) throw new Error("Unexpected group changes");
    if (outcome.exitCode === 0 && !enrolled) throw new Error("Successful enrollment was not observed");
    await unlink(pending);
    try { await sync(); }
    catch {
      // Keep a visible fail-closed fence when durable removal cannot be confirmed.
      const recovery = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await recovery.writeFile(JSON.stringify({ formatVersion: 1, checksum })); await recovery.sync(); } finally { await recovery.close(); }
      await sync();
      throw new Error("Pending fence removal durability was not confirmed");
    }
    uncertain = false;
    return enrolled ? manual("Docker group enrollment is complete. Log out and start a new login session, then rerun Fleur. Existing memberships were preserved.", "new-login-required") : manual("OS authorization or enrollment failed. Existing membership is unchanged; inspect authentication and retry with fresh authority.");
  } catch { return failure("setup", uncertain ? 5 : 4, { code: uncertain ? "RECOVERY_REQUIRED" : "PREREQUISITE_UNAVAILABLE", message: uncertain ? "The Docker access action or its durable recovery state is uncertain. Its pending fence was preserved; inspect the local account before resuming." : "The local user, Docker group, socket or service identity could not be verified. No enrollment was performed.", actions: [] }); }
}
