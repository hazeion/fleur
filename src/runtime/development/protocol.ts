import { createHmac, timingSafeEqual } from "node:crypto";
import type { Binding, State } from "./state";
import { startIdentity } from "./state";

export function publicState(state: State) {
  return { state: state.state, ready: state.state === "ready", instance: state.instance, url: state.url, generation: state.generation, error: state.error, initialization: state.initialization, initializationSummary: state.initializationSummary, prerequisites: state.prerequisites };
}
export function logs(state: State, limit: number, cursor?: string) {
  let after = 0;
  if (cursor) {
    const pieces = cursor.split(".");
    if (pieces.length !== 2 || !/^[0-9]+$/.test(pieces[0]!) || pieces[0]!.length > 16 || !/^[a-f0-9]{64}$/.test(pieces[1]!)) throw new Error("ARGUMENT_INVALID");
    const mac = createHmac("sha256", state.token).update(`${state.binding}:${pieces[0]}`).digest("hex");
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(pieces[1]!))) throw new Error("ARGUMENT_INVALID");
    after = Number(pieces[0]);
    if (!Number.isSafeInteger(after) || after > state.logSequence) throw new Error("ARGUMENT_INVALID");
  }
  const found = state.logs.filter(log => log.sequence > after), page = found.slice(0, limit);
  const sequence = page.at(-1)?.sequence ?? after, text = String(sequence);
  return { logs: page, cursor: text+"."+createHmac("sha256", state.token).update(`${state.binding}:${text}`).digest("hex"), truncated: found.length > limit || (after > 0 && after < (state.logs[0]?.sequence ?? 1) - 1) };
}
export async function control(bound: Binding, state: State, action: "status" | "stop", timeoutMs: number) {
  if (state.binding !== bound.id || await startIdentity(state.pid) !== state.start) throw new Error("INSTANCE_UNAVAILABLE");
  const response = await fetch(`http://127.0.0.1:${state.control}/${action}`, { method: "POST", headers: { authorization: `Bearer ${state.token}`, "x-fleur-instance": state.instance, "x-fleur-timeout-ms": String(timeoutMs) }, signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs + (action === "status" ? 500 : 0)))) });
  if (!response.ok) throw new Error("INSTANCE_UNAVAILABLE");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("instance" in value) || value.instance !== state.instance) throw new Error("INSTANCE_UNAVAILABLE");
  return value;
}
