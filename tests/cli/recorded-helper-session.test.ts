import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import origin from "../../experiments/compatibility/runtime-probe/recorded-helper-origin.json";
const observer = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts");
const nonce = "12345678-1234-4234-8234-123456789abc";
const binding = { nonce, bootId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", uid: 1000, manifestSha256: "a".repeat(64) };
const inputs = { manifestSha256: "26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b", directoryIdentity: Array(8).fill("1"), files: Object.fromEntries(origin.helpers.map((item) => [item.name, { size: item.bytes, sha256: item.sha256, identity: Array(8).fill("1") }])) };
// External SSH protocol fixture only: no compiled bytes, native runtime or disposal claim.
async function observe(selected: unknown, guest: unknown, owned = true) {
  const root = await mkdtemp(join(tmpdir(), "fleur-recorded-session-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}\nawait Bun.write(process.env.FIXTURE_ROOT+'/args',JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});process.stdout.write(${JSON.stringify(JSON.stringify(guest))});process.exit(${(guest as { ok?: boolean }).ok === true ? 0 : 4});\n`, { mode: 0o700 });
    const target = { port: 2222, identity: join(root, "client"), knownHosts: join(root, "pins"), nonce, ...(owned ? { ownedGuestBinding: binding } : {}), recordedHelpers: selected };
    const child = Bun.spawn([process.execPath, "-e", `import {observeGuestSessions} from ${JSON.stringify(observer)};console.log(JSON.stringify(await observeGuestSessions(${JSON.stringify(target)})));`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { PATH: tools + ":/usr/bin:/bin", HOME: root, FIXTURE_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    const args = await Bun.file(join(root, "args")).exists() ? JSON.parse(await readFile(join(root, "args"), "utf8")) as string[] : undefined;
    return { result: JSON.parse(stdout), args };
  } finally { await rm(root, { recursive: true, force: true }); }
}
const pending = { formatVersion: 1, ok: false, runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, helperMode: "recorded-prebuilt", recordedHelperInputs: inputs };
test("recorded helper selection reaches only the fixed guest command while preserving incomplete proof", async () => {
  const observed = await observe(true, pending);
  expect(observed.args?.at(-1)).toEndWith(" --recorded-helpers");
  expect(observed.result).toMatchObject({ ok: false, guest: pending });
}, 15000);
test("selected session refuses a report that drops its immutable helper inputs", async () => {
  const dropped = { ...pending, recordedHelperInputs: undefined };
  const observed = await observe(true, dropped);
  expect(observed.result.error?.code).toBe("SESSION_FAILED");
  expect(observed.result.error?.message).toContain("recorded helper input binding");
}, 15000);

test("recorded terminal proof cannot borrow the legacy local compiler claim", async () => {
  const round = { exitCode: 4, result: { formatVersion: 1, command: "doctor", ok: false, truncated: false, error: { code: "PREREQUISITE_UNAVAILABLE" }, data: { components: { cli: { state: "ready" }, daemon: { state: "ready" }, compose: { state: "ready" }, smoke: { state: "ready", cleanup: true }, release: { state: "unverified" } } } } };
  const guest = { ...pending, ok: true, installationEvidence: "verified-full-system-guest", baseline: { original: true }, runs: [round, round], sentinelCleanup: true, restrictionProbe: { exitCode: 0, result: { bounded_probe_passed: true, cleanup_complete: true, compiler_pin_verified: true } } };
  const observed = await observe(true, guest);
  expect(observed.result.ok).toBe(false);
  expect(observed.result.error?.message).toContain("recorded helper origin");
}, 15000);

for (const [selection, owned] of [[false, true], ["true", true], [true, false]] as const) {
  test(`recorded selection ${selection}/owned=${owned} refuses before SSH startup`, async () => {
    const observed = await observe(selection, pending, owned);
    expect(observed.result.error?.code).toBe("ARGUMENT_INVALID");
    expect(observed.args).toBeUndefined();
  }, 15000);
}
