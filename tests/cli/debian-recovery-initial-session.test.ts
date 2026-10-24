import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import recordedOrigin from "../../experiments/compatibility/runtime-probe/recorded-helper-origin.json";

// An external SSH protocol fixture. It executes no guest setup or native VM.
test("failed initial Debian recovery retains the exact guest diagnosis without accepting a reboot checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-recovery-initial-protocol-"));
  try {
    const nonce = "12345678-1234-4234-8234-123456789abc";
    const binding = { nonce, bootId: "87654321-4321-4321-8321-cba987654321", uid: 1000, manifestSha256: "b".repeat(64) };
    const os = { id: "debian", versionId: "13", sha256: "d".repeat(64) };
    const identity = Array.from({ length: 8 }, () => "1");
    const failed = {
      formatVersion: 1, ok: false, installationEvidence: "pending", runtimeSupport: "unverified", humanConsentProof: false,
      ownedGuestCustody: { ...binding, osRelease: os, formatVersion: 1, scope: "owned-guest-custody-validation", ok: true, fixtureCustodyValidated: true, runtimeSupport: "unverified", runtimeAdmission: false, humanConsentProof: false, nativeCpuPerformanceProof: false },
      helperMode: "recorded-prebuilt",
      recordedHelperInputs: { manifestSha256: "26167bf5307aacabbec7f51e05e348418170d98075baa1964b971460988cf47b", directoryIdentity: identity, files: Object.fromEntries(recordedOrigin.helpers.map((pin) => [pin.name, { size: pin.bytes, sha256: pin.sha256, identity }])) },
      qualificationSource: { scope: "source-owned-debian-interruption-inputs", sourceCommit: "a".repeat(40), sha256: "e".repeat(64) },
      baseline: { packages: "unchanged protocol fixture" },
      error: { code: "INTERRUPTION_QUALIFICATION_FAILED", message: "Fixture failed before the completed-effects receipt window" },
    };
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}
const path=process.env.FIXTURE_ROOT+'/connections.json';const calls=await Bun.file(path).exists()?await Bun.file(path).json():[];
calls.push({pid:process.pid,args:process.argv.slice(2)});await Bun.write(path,JSON.stringify(calls));
process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")});process.stdout.write(${JSON.stringify(JSON.stringify(failed))});process.exit(4);
`, { mode: 0o700 });
    const target = { port: 2222, identity: "key", knownHosts: "pins", nonce, ownedGuestBinding: binding, ownedGuestOsRelease: os, recordedHelpers: true, qualificationSourceSha256: "e".repeat(64) };
    const entry = `const {observeInterruptionInitial}=await import(${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-debian-interruption-initial.ts"))});const result=await observeInterruptionInitial({...${JSON.stringify(target)},phaseDeadline:performance.now()+5000});console.log(JSON.stringify(result));process.exit(result.ok?0:4);`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":" + process.env.PATH, FIXTURE_ROOT: root } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(code, stdout).toBe(4);
    const observed = JSON.parse(stdout);
    const calls = await Bun.file(join(root, "connections.json")).json();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("StrictHostKeyChecking=yes");
    expect(calls[0].args).toContain("IdentityAgent=none");
    expect(calls[0].args).toContain("ControlMaster=no");
    expect(calls[0].args).toContain("fleur@127.0.0.1");
    expect(calls[0].args.at(-1)).toContain("python3 -I lab/fleur-interrupted-guest.py " + nonce);
    expect(calls[0].args.at(-1)).toContain("--qualification-source " + "e".repeat(64));
    expect(() => process.kill(calls[0].pid, 0)).toThrow();
    expect(observed).toMatchObject({ formatVersion: 1, scope: "interrupted-linux-initial-observation", ok: false, error: { code: "SESSION_FAILED", message: "Initial native interruption did not establish its completed-effects checkpoint." } });
    expect(observed.guest).toBeUndefined();
    expect(observed.phase).toBeUndefined();
    expect(observed.interruptionCheckpointSha256).toBeUndefined();
    expect(observed.initialGuest).toEqual(failed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
