import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("failed external Arch collector retains exact partial facts and retires its sole SSH process", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-arch-collector-protocol-"));
  try {
    const binding = { nonce: "12345678-1234-4234-8234-123456789abc", bootId: "87654321-4321-4321-8321-cba987654321", uid: 1000, manifestSha256: "b".repeat(64) };
    const failed = { formatVersion: 1, scope: "fixed-arch-read-only-boot-observation", ok: false, installationVerified: false, nativeQualification: false, runtimeAdmission: false, humanConsentProof: false, nativeCpuPerformanceProof: false,
      commands: [{ name: "runtime-packages", completed: false, processGroupRetired: false, stdoutBytes: 13, stdoutSha256: "c".repeat(64), queryFailure: "TimeoutError", retirementError: "PermissionError" }],
      error: { type: "PermissionError", message: "Controlled query retirement remains unconfirmed" } };
    const tools = join(root, "tools"); await mkdir(tools);
    await writeFile(join(tools, "ssh"), `#!${process.execPath}
await Bun.write(process.env.ARCH_FIXTURE_ROOT+'/connection.json',JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));process.stdout.write(${JSON.stringify(JSON.stringify(failed))});process.exit(4);
`, { mode: 0o700 });
    const source = "d".repeat(64);
    const entry = `const {collectArchObservation}=await import(${JSON.stringify(resolve(import.meta.dir, "../../scripts/observe-arch-boot.ts"))});const result={ok:false};try{await collectArchObservation({sshOptions:['-F','/dev/null','-o','StrictHostKeyChecking=yes','-o','IdentityAgent=none'],port:2222,sourceSha256:${JSON.stringify(source)},binding:${JSON.stringify(binding)},deadline:performance.now()+5000,signal:new AbortController().signal},result);throw Error('Failed fixture unexpectedly accepted')}catch(error){result.error=error.message}console.log(JSON.stringify(result));process.exit(result.ok?0:4);`;
    const child = Bun.spawn([process.execPath, "--eval", entry], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000, env: { ...process.env, PATH: tools + ":" + process.env.PATH, ARCH_FIXTURE_ROOT: root } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); expect(code).toBe(4);
    const result = JSON.parse(stdout);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Fixed Arch guest observation failed");
    expect(result.observation).toEqual(failed);
    expect(result.observationTransport).toEqual({ exitCode: 4, stderrSha256: Bun.CryptoHasher.hash("sha256", "", "hex"), completed: true });
    const connection = await Bun.file(join(root, "connection.json")).json();
    expect(connection.args).toContain("StrictHostKeyChecking=yes");
    expect(connection.args).toContain("IdentityAgent=none");
    expect(connection.args).toContain("ControlMaster=no");
    expect(connection.args.at(-1)).toBe(`/usr/bin/python3 -I /usr/local/lib/fleur-arch-boot-observation.py --observe ${binding.nonce} ${source} ${binding.bootId} ${binding.manifestSha256}`);
    expect(() => process.kill(connection.pid, 0)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
