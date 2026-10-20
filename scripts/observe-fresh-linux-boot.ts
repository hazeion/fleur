import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
export interface BootTarget { port: number; identity: string; knownHosts: string; nonce: string }
export interface BootObservation { formatVersion: 1; scope: "fresh-linux-boot-observation"; ok: boolean; state: "ready" | "pending" | "failed"; cloudInitComplete?: boolean; nonceMatched?: boolean; error?: { code: string; message: string } }
const result = (state: BootObservation["state"], error?: BootObservation["error"]): BootObservation => ({ formatVersion: 1, scope: "fresh-linux-boot-observation", ok: state === "ready", state, ...(error ? { error } : {}) });
async function bounded(stream: Readable): Promise<string> {
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of stream) { const part = Buffer.from(chunk); size += part.length; if (size > 2 * 1024 * 1024) throw new Error("Boot observation output exceeded its limit"); parts.push(part); }
  return Buffer.concat(parts).toString("utf8");
}
/** One bounded observation of an owned guest through its pinned loopback SSH transport. */
export async function observeBoot(target: BootTarget, remainingBudgetMs = 10000): Promise<BootObservation> {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9-]{36}$/.test(target.nonce) || !target.identity || !target.knownHosts) return result("failed", { code: "ARGUMENT_INVALID", message: "A pinned loopback transport and exact guest nonce are required." });
  const remote = [
    "if ! test -f /var/lib/cloud/instance/boot-finished; then exit 75; fi",
    "cloud-init status --format=json",
    'status=$?; if [ "$status" -ne 0 ]; then exit "$status"; fi',
    "printf '\\nFLEUR_OWNED_GUEST_NONCE='",
    "cat /etc/fleur-owned-guest",
  ].join("; ");
  const child = spawn("ssh", ["-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHosts}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=3", "-i", target.identity, "-p", String(target.port), "fleur@127.0.0.1", remote], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SSH_AUTH_SOCK: undefined, SSH_ASKPASS: undefined, DISPLAY: undefined } });
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
  const timer = setTimeout(kill, Math.max(1, Math.min(10000, remainingBudgetMs)));
  const finished = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 1))); });
  try {
    const [stdout, stderr, code] = await Promise.all([bounded(child.stdout!), bounded(child.stderr!), finished]);
    if (code === 75) return result("pending");
    const preAuthenticationReset = `kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 127.0.0.1 port ${target.port}\r\n`;
    if (code === 255 && stdout === "" && (stderr === preAuthenticationReset || stderr === preAuthenticationReset.replaceAll("\r\n", "\n"))) return result("pending");
    if (code === 255 && /(?:connect to host 127\.0\.0\.1 port [0-9]+: Connection (?:refused|timed out)|Connection timed out during banner exchange)/.test(stderr)) return result("pending");
    if (code !== 0) return result("failed", { code: "SSH_FAILED", message: `Boot transport exited ${code}: ${stderr.slice(-2048)}` });
    const delimiter = "\nFLEUR_OWNED_GUEST_NONCE="; const split = stdout.indexOf(delimiter);
    if (split < 0 || split !== stdout.lastIndexOf(delimiter) || stdout.slice(split + delimiter.length).replace(/\r?\n$/, "") !== target.nonce) return result("failed", { code: "GUEST_IDENTITY_MISMATCH", message: "Completed boot evidence did not carry the exact owned guest nonce." });
    const status: unknown = JSON.parse(stdout.slice(0, split));
    if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Cloud-init status is not an object");
    const fields = status as Record<string, unknown>;
    const errorsPresent = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      return Object.entries(value).some(([key, detail]) => ["errors", "recoverable_errors"].includes(key)
        ? detail !== undefined && (Array.isArray(detail) ? detail.length !== 0 : !detail || typeof detail !== "object" || Object.keys(detail).length !== 0)
        : errorsPresent(detail));
    };
    if (errorsPresent(status)) return result("failed", { code: "CLOUD_INIT_FAILED", message: "Cloud-init reports errors or recovered errors." });
    if (["running", "not started"].includes(String(fields.status))) return result("pending");
    if (fields.status !== "done" || (fields.extended_status !== undefined && fields.extended_status !== "done")) return result("failed", { code: "CLOUD_INIT_FAILED", message: "Cloud-init did not report an exact completed, non-degraded state." });
    return { ...result("ready"), cloudInitComplete: true, nonceMatched: true };
  } catch (error) { return result("failed", { code: "BOOT_OBSERVATION_FAILED", message: error instanceof Error ? error.message : "Boot observation failed" }); }
  finally { clearTimeout(timer); kill(); await finished.catch(() => {}); }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const observed = args.length === 8 && args[0] === "--port" && args[2] === "--identity" && args[4] === "--known-hosts" && args[6] === "--nonce"
    ? await observeBoot({ port: Number(args[1]), identity: args[3]!, knownHosts: args[5]!, nonce: args[7]! })
    : result("failed", { code: "ARGUMENT_INVALID", message: "Use --port <loopback-port> --identity <key> --known-hosts <pins> --nonce <guest-nonce>." });
  process.stdout.write(JSON.stringify(observed) + "\n"); process.exitCode = observed.state === "ready" ? 0 : observed.state === "pending" ? 3 : 4;
}
