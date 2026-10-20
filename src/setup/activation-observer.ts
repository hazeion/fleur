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
async function endpointIdentity(host: SetupHost, remaining: () => number, path: string, expectedType: "socket" | "fifo", absentAllowed: boolean): Promise<string | null> {
  if (remaining() <= 0 || path.length > 4096 || !path.startsWith("/") || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Invalid passive socket path");
  const result = await host.run(["/usr/bin/stat", "--dereference", "--format=%d|%i|%F", "--", path], remaining());
  if (absentAllowed && result.status === "completed" && result.exitCode === 1 && /No such file or directory/.test(result.stderr) && result.stdout.trim() === "" && !("terminationUnconfirmed" in result && result.terminationUnconfirmed)) return null;
  const identity = result.stdout.length <= 128 ? (expectedType === "socket" ? /^([0-9]+)\|([1-9][0-9]*)\|socket\s*$/ : /^([0-9]+)\|([1-9][0-9]*)\|fifo\s*$/).exec(result.stdout) : null;
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
/** No RPC or privileged command: inspect all loaded system activation sockets before contacting this endpoint. */
export async function observeEndpointActivation(host: SetupHost, remaining: () => number, endpoint: string): Promise<ActivationObservation> {
  if (!["unix:///run/docker.sock", "unix:///var/run/docker.sock"].includes(endpoint)) return { state: "clear" };
  try {
    const selected = await endpointIdentity(host, remaining, endpoint.slice(7), "socket", true);
    if (selected === null) return { state: "clear" };
    const inventory = await read(host, remaining, ["/usr/bin/systemctl", "--system", "list-units", "--all", "--type=socket", "--plain", "--no-legend", "--no-pager", "--full"]);
    const names: string[] = [];
    for (const row of inventory.trim().split("\n").filter(Boolean)) {
      const name = row.trim().split(/\s+/, 1)[0]!;
      if (!unitName.test(name) || !name.endsWith(".socket") || names.includes(name) || names.length >= 64) throw new Error("Socket inventory is malformed or oversized");
      names.push(name);
    }
    const blocked = new Set<string>();
    const triggers = new Set<string>();
    for (const unit of names) {
      const { values, listens } = await properties(host, remaining, unit, true);
      if (values.ActiveState === "inactive" && values.SubState === "dead" && values.LoadState === "loaded") continue;
      if (values.ActiveState !== "active" || (values.SubState !== "listening" && values.SubState !== "running")) throw new Error("Socket lifecycle is not a stable listening/running/inactive state");
      if (values.LoadState !== "loaded" || !listens.length) throw new Error("Socket state is incomplete");
      let matching = false;
      for (const listen of listens) {
        const entry = /^(.*) \((Stream|Datagram|SequentialPacket|Netlink|FIFO)\)$/.exec(listen);
        if (!entry) throw new Error("Socket Listen value is malformed");
        const path = entry[1]!;
        const kind = entry[2]!;
        if (kind === "FIFO" && !path.startsWith("/")) throw new Error("FIFO listener path is not absolute");
        if (path.startsWith("/")) {
          if (kind === "Netlink") throw new Error("Netlink listener cannot name a filesystem endpoint");
          const identity = await endpointIdentity(host, remaining, path, kind === "FIFO" ? "fifo" : "socket", false);
          if (identity === selected) {
            if (kind === "FIFO") throw new Error("Listener type conflicts with the selected socket identity");
            matching = true;
          }
        }
      }
      if (!matching) continue;
      const targets = values.Triggers!.split(/\s+/).filter(Boolean);
      if (!targets.length || targets.length > 16 || new Set(targets).size !== targets.length || targets.some((target) => !unitName.test(target) || !target.endsWith(".service"))) throw new Error("Activation targets incomplete");
      for (const target of targets) {
        const state = (await properties(host, remaining, target, false)).values;
        if (state.LoadState !== "loaded" || state.ActiveState !== "active" || state.SubState !== "running" || values.ActiveState !== "active" || (values.SubState !== "listening" && values.SubState !== "running")) { blocked.add(unit); triggers.add(target); }
      }
    }
    return blocked.size ? { state: "activation-needed", sockets: [...blocked].sort(), triggers: [...triggers].sort() } : { state: "clear" };
  } catch { return { state: "activation-unknown" }; }
}
