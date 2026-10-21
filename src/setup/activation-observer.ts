import type { UnixSocketRecord, UnixSocketSnapshot } from "./unix-diag.ts";
import type { HostCommandResult, SetupHost } from "./commands.ts";
export type ActivationObservation = { readonly state: "clear" } | { readonly state: "activation-needed"; readonly sockets: readonly string[]; readonly triggers: readonly string[] } | { readonly state: "activation-unknown" };
/** Absence means no activation hazard was observed; every reported hazard needs an exact reviewed target. */
export function permitsArchSystemStart(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.state === "activation-needed" && JSON.stringify(state.sockets) === '["docker.socket"]' && JSON.stringify(state.triggers) === '["docker.service"]';
}
function confirmed(result: HostCommandResult): boolean { return result.status === "completed" && result.exitCode === 0 && !("terminationUnconfirmed" in result && result.terminationUnconfirmed === true); }
const unitName = /^[A-Za-z0-9_@:.\\-]+\.(?:socket|service)$/;
async function read(host: SetupHost, remaining: () => number, args: readonly string[]): Promise<string> {
  if (remaining() <= 0) throw new Error("Activation observation deadline");
  const result = await host.run(args, remaining());
  if (!confirmed(result) || result.stdout.length > 65536) throw new Error("Activation observation incomplete");
  return result.stdout;
}
class ProtectedSocketPath extends Error {}
async function endpointIdentity(host: SetupHost, remaining: () => number, path: string, expectedType: "socket" | "fifo" | "character", absentAllowed: boolean): Promise<string | null> {
  if (remaining() <= 0 || path.length > 4096 || !path.startsWith("/") || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Invalid passive socket path");
  const result = await host.run(["/usr/bin/stat", "--dereference", "--format=%d|%i|%F", "--", path], remaining());
  if (absentAllowed && result.status === "completed" && result.exitCode === 1 && /No such file or directory/.test(result.stderr) && result.stdout.trim() === "" && !("terminationUnconfirmed" in result && result.terminationUnconfirmed)) return null;
  if (expectedType === "socket" && !absentAllowed && result.status === "completed" && result.exitCode === 1 && !result.terminationUnconfirmed && result.stdout === "" && /^[A-Za-z0-9_./@+%~:-]+$/.test(path) && result.stderr === `/usr/bin/stat: cannot statx '${path}': Permission denied\n`) throw new ProtectedSocketPath();
  const identity = result.stdout.length <= 128 ? (expectedType === "socket" ? /^([0-9]+)\|([1-9][0-9]*)\|socket\s*$/ : expectedType === "fifo" ? /^([0-9]+)\|([1-9][0-9]*)\|fifo\s*$/ : /^([0-9]+)\|([1-9][0-9]*)\|character special file\s*$/).exec(result.stdout) : null;
  if (!confirmed(result) || !identity) throw new Error("Endpoint identity unavailable");
  return `${BigInt(identity[1]!)}|${BigInt(identity[2]!)}`;
}
async function properties(host: SetupHost, remaining: () => number, unit: string, socket: boolean) {
  const keys = ["Id", "LoadState", "ActiveState", "SubState", ...(socket ? ["Listen", "Triggers"] : [])];
  const text = await read(host, remaining, ["/usr/bin/systemctl", "--system", "show", "--all", "--no-pager", `--property=${keys.join(",")}`, "--", unit]);
  const values: Record<string, string> = {};
  const listens: string[] = [];
  let seenListen = false;
  for (const row of text.trimEnd().split("\n")) {
    const index = row.indexOf("=");
    const key = row.slice(0, index);
    if (index < 1 || !keys.includes(key)) throw new Error("Unknown activation metadata");
    const value = row.slice(index + 1);
    if (key === "Listen") { seenListen = true; if (value) listens.push(value); }
    else { if (Object.hasOwn(values, key)) throw new Error("Duplicate activation metadata"); values[key] = value; }
  }
  if (values.Id !== unit || Object.keys(values).length !== keys.length - (socket ? 1 : 0) || (socket && !seenListen) || listens.length > 128) throw new Error("Missing activation metadata");
  return { values, listens };
}
function socketNames(inventory: string): string[] {
  const names: string[] = [];
  for (const row of inventory.trim().split("\n").filter(Boolean)) {
    const name = row.trim().split(/\s+/, 1)[0]!;
    if (!unitName.test(name) || !name.endsWith(".socket") || names.includes(name) || names.length >= 64) throw new Error("Socket inventory is malformed or oversized");
    names.push(name);
  }
  return names;
}
function relevantBinding(snapshot: UnixSocketSnapshot, name: string, kind: string): UnixSocketRecord {
  if (snapshot.state !== "complete") throw new Error("Kernel identity unavailable");
  // Accepted stream children inherit NAME/VFS; only the listening binding can activate a service.
  const matches = snapshot.records.filter((record) => record.name === name && ((record.socketType === 1 || record.socketType === 5) ? record.state === 10 : record.socketType === 2));
  const record = matches[0]; const expectedType = kind === "Stream" ? 1 : kind === "Datagram" ? 2 : 5;
  if (matches.length !== 1 || !record?.vfs || record.socketType !== expectedType || (record.socketType === 2 && record.state !== 1 && record.state !== 7)) throw new Error("Ambiguous kernel binding");
  return record;
}
function bindingKey(record: UnixSocketRecord): string { return JSON.stringify([record.name, record.socketType, record.state, record.socketInode, record.cookie, record.vfs]); }
function metadataKey(value: Awaited<ReturnType<typeof properties>>): string { return JSON.stringify([Object.entries(value.values).sort(), [...value.listens].sort()]); }
/** No RPC or privileged command: inspect all loaded system activation sockets before contacting this endpoint. */
export async function observeEndpointActivation(host: SetupHost, remaining: () => number, endpoint: string): Promise<ActivationObservation> {
  if (!["unix:///run/docker.sock", "unix:///var/run/docker.sock"].includes(endpoint)) return { state: "clear" };
  try {
    const selected = await endpointIdentity(host, remaining, endpoint.slice(7), "socket", true);
    if (selected === null) return { state: "clear" };
    const inventory = await read(host, remaining, ["/usr/bin/systemctl", "--system", "list-units", "--all", "--type=socket", "--plain", "--no-legend", "--no-pager", "--full"]);
    const names = socketNames(inventory);
    const inventoryArgs = ["/usr/bin/systemctl", "--system", "list-units", "--all", "--type=socket", "--plain", "--no-legend", "--no-pager", "--full"];
    let wireRemaining = 3000;
    let firstSnapshot: Promise<UnixSocketSnapshot> | undefined;
    const relevant = new Map<string, { kind: string; key: string }>();
    const units = new Map<string, { socket: boolean; key: string }>();
    const rememberUnit = (unit: string, socket: boolean, key: string) => {
      const prior = units.get(unit);
      if (prior && (prior.socket !== socket || prior.key !== key)) throw new Error("Activation metadata changed during observation");
      if (!prior) units.set(unit, { socket, key });
    };
    const snapshot = async (): Promise<UnixSocketSnapshot> => {
      if (!host.unixSocketSnapshot || wireRemaining <= 0 || remaining() <= 0) throw new Error("Kernel observation unavailable");
      const start = performance.now();
      try {
        const value = await host.unixSocketSnapshot(Math.min(wireRemaining, remaining()));
        if (performance.now() - start > wireRemaining || remaining() <= 0) throw new Error("Kernel observation deadline");
        return value;
      } finally { wireRemaining -= performance.now() - start; }
    };
    const protectedIdentity = async (path: string, kind: string): Promise<boolean> => {
      const [device, inode] = selected.split("|").map(BigInt) as [bigint, bigint];
      const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
      const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
      if (inode > 0xffffffffn || major > 0xfffn || minor > 0xfffffn || device < 0n || device > 0xffffffffffffffffn) throw new Error("Unsupported selected VFS identity");
      firstSnapshot ??= snapshot();
      const record = relevantBinding(await firstSnapshot, path, kind);
      relevant.set(path, { kind, key: bindingKey(record) });
      return BigInt(record.vfs!.device >>> 20) === major && BigInt(record.vfs!.device & 0xfffff) === minor && BigInt(record.vfs!.inode) === inode;
    };
    const blocked = new Set<string>();
    const triggers = new Set<string>();
    for (const unit of names) {
      const observed = await properties(host, remaining, unit, true);
      const { values, listens } = observed;
      rememberUnit(unit, true, metadataKey(observed));
      if (values.ActiveState === "inactive" && values.SubState === "dead" && values.LoadState === "loaded") continue;
      if (values.ActiveState !== "active" || (values.SubState !== "listening" && values.SubState !== "running")) throw new Error("Socket lifecycle is not a stable listening/running/inactive state");
      if (values.LoadState !== "loaded" || !listens.length) throw new Error("Socket state is incomplete");
      let matching = false;
      for (const listen of listens) {
        const entry = /^(.*) \((Stream|Datagram|SequentialPacket|Netlink|FIFO|Special)\)$/.exec(listen);
        if (!entry) throw new Error("Socket Listen value is malformed");
        const path = entry[1]!;
        const kind = entry[2]!;
        if ((kind === "FIFO" || kind === "Special") && !path.startsWith("/")) throw new Error("FIFO listener path is not absolute");
        if (path.startsWith("/")) {
          if (kind === "Netlink") throw new Error("Netlink listener cannot name a filesystem endpoint");
          try {
            const identity = await endpointIdentity(host, remaining, path, kind === "FIFO" ? "fifo" : kind === "Special" ? "character" : "socket", false);
            if (identity === selected) {
              if (kind === "FIFO" || kind === "Special") throw new Error("Listener type conflicts with the selected socket identity");
              matching = true;
            }
          } catch (error) {
            if (!(error instanceof ProtectedSocketPath) || kind === "FIFO" || kind === "Special") throw error;
            if (await protectedIdentity(path, kind)) matching = true;
          }
        }
      }
      if (!matching) continue;
      const targets = values.Triggers!.split(/\s+/).filter(Boolean);
      if (!targets.length || targets.length > 16 || new Set(targets).size !== targets.length || targets.some((target) => !unitName.test(target) || !target.endsWith(".service"))) throw new Error("Activation targets incomplete");
      for (const target of targets) {
        const targetProperties = await properties(host, remaining, target, false);
        rememberUnit(target, false, metadataKey(targetProperties));
        const state = targetProperties.values;
        if (state.LoadState !== "loaded" || state.ActiveState !== "active" || state.SubState !== "running" || values.ActiveState !== "active" || (values.SubState !== "listening" && values.SubState !== "running")) { blocked.add(unit); triggers.add(target); }
      }
    }
    if (firstSnapshot) {
      if (JSON.stringify(socketNames(await read(host, remaining, inventoryArgs)).sort()) !== JSON.stringify([...names].sort()) || await endpointIdentity(host, remaining, endpoint.slice(7), "socket", true) !== selected) throw new Error("Activation inventory or selected identity changed");
      for (const [unit, original] of units) if (metadataKey(await properties(host, remaining, unit, original.socket)) !== original.key) throw new Error("Activation metadata changed");
      const second = await snapshot();
      for (const [path, original] of relevant) if (bindingKey(relevantBinding(second, path, original.kind)) !== original.key) throw new Error("Kernel binding changed");
    }
    return blocked.size ? { state: "activation-needed", sockets: [...blocked].sort(), triggers: [...triggers].sort() } : { state: "clear" };
  } catch { return { state: "activation-unknown" }; }
}
