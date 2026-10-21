import { expect, spyOn, test } from "bun:test";
import { observeGuestSessions } from "../../scripts/observe-fresh-linux-session.ts";

test("partial owned session identity is refused before any process starts", async () => {
  let attempted = false;
  const processBoundary = spyOn(Bun, "spawn").mockImplementation(() => { attempted = true; throw new Error("invalid binding reached process boundary"); });
  try {
    const target = { port: 2222, identity: "fixture-key", knownHosts: "fixture-hosts", nonce: "12345678-1234-4234-8234-123456789abc", ownedGuestBinding: JSON.parse('{"uid":1000}') };
    const result = await observeGuestSessions(target);
    expect(result).toMatchObject({ ok: false, error: { code: "ARGUMENT_INVALID" } });
    expect(attempted).toBe(false);
  } finally { processBoundary.mockRestore(); }
});

test("initial and resumed SSH commands retain the same copied original owned binding", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "fleur-owned-session-"));
  try {
    const tools = join(root, "tools"); await mkdir(tools);
    const nonce = "12345678-1234-4234-8234-123456789abc";
    const bootId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const baseline = { packages: "fixture" };
    const pending = { formatVersion: 1, ok: false, phase: "new-login-required", runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline, checkpoint: { sha256: "b".repeat(64), bytes: 800 }, accessHandoff: { after: { user: { name: "fleur", uid: 1000 }, group: { name: "docker", gid: 997 }, accountGroups: [27, 997, 1000], sessionGroups: [27, 1000] } } };
    const resumed = { formatVersion: 1, ok: false, runtimeSupport: "unverified", installationEvidence: "pending", humanConsentProof: false, baseline, accessResume: { checkpointSha256: "b".repeat(64), sessionGroups: [27, 997, 1000] }, error: { code: "NATIVE_SETUP_INCOMPLETE" } };
    await writeFile(join(tools, "ssh"), `#!${process.execPath}
const path=process.env.OWNED_SESSION_ROOT+'/calls.json';const calls=await Bun.file(path).exists()?await Bun.file(path).json():[];
calls.push(process.argv.at(-1));await Bun.write(path,JSON.stringify(calls));
process.stdout.write(${JSON.stringify("FLEUR_SESSION_READY=" + nonce + "\n")}+(calls.length===1?${JSON.stringify(JSON.stringify(pending))}:${JSON.stringify(JSON.stringify(resumed))}));process.exit(calls.length===1?3:4);
`, { mode: 0o700 });
    const runner = join(root, "runner.ts");
    await writeFile(runner, `import {observeGuestSessions} from ${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-fresh-linux-session.ts"))};
const binding={nonce:${JSON.stringify(nonce)},bootId:${JSON.stringify(bootId)},uid:1000,manifestSha256:'a'.repeat(64)};
const operation=observeGuestSessions({port:2222,identity:'key',knownHosts:'pins',nonce:binding.nonce,ownedGuestBinding:binding});
binding.uid=999;binding.bootId='ffffffff-ffff-4fff-8fff-ffffffffffff';
process.stdout.write(JSON.stringify(await operation));`);
    const child = Bun.spawn([process.execPath, runner], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":" + process.env.PATH, OWNED_SESSION_ROOT: root } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, initialGuest: pending, guest: resumed });
    const calls = JSON.parse(await readFile(join(root, "calls.json"), "utf8"));
    expect(calls).toHaveLength(2);
    const suffix = ` --owned-guest-boot-id ${bootId} --owned-guest-uid 1000 --owned-guest-manifest-sha256 ${"a".repeat(64)}`;
    expect(calls[0]).toEndWith(`python3 lab/fresh-linux-guest.py ${nonce}${suffix}`);
    expect(calls[1]).toEndWith(`python3 lab/fresh-linux-guest.py ${nonce} --resume ${"b".repeat(64)}${suffix}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
