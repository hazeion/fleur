import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../scripts/observe-fresh-linux-boot.ts");
const nonce = "12345678-1234-1234-1234-123456789abc";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleur-boot-protocol-"));
  const tools = join(root, "tools"); await mkdir(tools);
  const remote = `test() { if [ "$1" = '-f' ] && [ "$2" = '/var/lib/cloud/instance/boot-finished' ]; then command test -f "$FIXTURE_ROOT/finished"; else command test "$@"; fi; }
cat() { if [ "$1" = '/etc/fleur-owned-guest' ]; then command cat "$FIXTURE_ROOT/nonce"; else command cat "$@"; fi; }
`;
  await writeFile(join(tools, "ssh"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT; const hard=await Bun.file(root+'/ssh-exit').text(); if(Number(hard)!==0){process.stderr.write(await Bun.file(root+'/ssh-stderr').text());process.exit(Number(hard));} const child=Bun.spawn(['/bin/sh','-c',${JSON.stringify(remote)}+process.argv.at(-1)],{stdin:'ignore',stdout:'inherit',stderr:'inherit',env:process.env});process.exit(await child.exited);\n`, { mode: 0o700 });
  await writeFile(join(tools, "cloud-init"), `#!${process.execPath}\nconst root=process.env.FIXTURE_ROOT; await Bun.write(root+'/cloud-init-calls',(await Bun.file(root+'/cloud-init-calls').exists()?await Bun.file(root+'/cloud-init-calls').text():'')+'called\\n'); if(process.argv.includes('--wait')){while(!await Bun.file(root+'/finished').exists())await Bun.sleep(100);} process.stdout.write(await Bun.file(root+'/status.json').text()); process.exit(Number(await Bun.file(root+'/cloud-init-exit').text()));\n`, { mode: 0o700 });
  await Promise.all([writeFile(join(root, "nonce"), nonce + "\n"), writeFile(join(root, "status.json"), JSON.stringify({ status: "done", extended_status: "done", errors: [], recoverable_errors: {} })), writeFile(join(root, "cloud-init-exit"), "0"), writeFile(join(root, "ssh-exit"), "0"), writeFile(join(root, "ssh-stderr"), "")]);
  const observe = async () => {
    const child = Bun.spawn([process.execPath, script, "--port", "2222", "--identity", join(root, "client"), "--known-hosts", join(root, "known_hosts"), "--nonce", nonce], { env: { PATH: tools + ":/usr/bin:/bin", FIXTURE_ROOT: root, HOME: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 12000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { exit, stderr, result: JSON.parse(stdout) as Record<string, unknown> };
  };
  return { root, observe };
}
test("boot observation returns promptly while cloud-init is busy, then requires completion and exact nonce", async () => {
  const { root, observe } = await fixture();
  try {
    const started = performance.now(); const pending = await observe();
    expect(pending).toMatchObject({ exit: 3, stderr: "", result: { formatVersion: 1, scope: "fresh-linux-boot-observation", state: "pending", ok: false } });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(await Bun.file(join(root, "cloud-init-calls")).exists()).toBe(false);
    await writeFile(join(root, "finished"), "finished");
    const ready = await observe();
    expect(ready).toMatchObject({ exit: 0, stderr: "", result: { state: "ready", ok: true, cloudInitComplete: true, nonceMatched: true } });
    expect((await readFile(join(root, "cloud-init-calls"), "utf8")).trim()).toBe("called");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
for (const scenario of ["running", "nonce-mismatch", "degraded", "errors", "recovered-errors", "nested-errors", "cloud-init-failed", "malformed", "host-key-failed", "connection-refused", "ssh-killed"] as const) {
  test(`boot observation preserves completed-init and transport rejection boundaries: ${scenario}`, async () => {
    const { root, observe } = await fixture();
    try {
      await writeFile(join(root, "finished"), "finished");
      if (scenario === "running") await writeFile(join(root, "status.json"), JSON.stringify({ status: "running" }));
      if (scenario === "nonce-mismatch") await writeFile(join(root, "nonce"), "00000000-0000-0000-0000-000000000000\n");
      if (scenario === "degraded") await writeFile(join(root, "status.json"), JSON.stringify({ status: "done", extended_status: "degraded done", errors: [] }));
      if (scenario === "errors") await writeFile(join(root, "status.json"), JSON.stringify({ status: "done", errors: ["module failed"] }));
      if (scenario === "recovered-errors") await writeFile(join(root, "status.json"), JSON.stringify({ status: "done", recoverable_errors: { WARNING: ["problem"] } }));
      if (scenario === "nested-errors") await writeFile(join(root, "status.json"), JSON.stringify({ status: "done", init: { errors: ["module failed"] } }));
      if (scenario === "cloud-init-failed") await writeFile(join(root, "cloud-init-exit"), "2");
      if (scenario === "malformed") await writeFile(join(root, "status.json"), "not json");
      if (scenario === "host-key-failed") { await writeFile(join(root, "ssh-exit"), "255"); await writeFile(join(root, "ssh-stderr"), "Host key verification failed.\n"); }
      if (scenario === "connection-refused") { await writeFile(join(root, "ssh-exit"), "255"); await writeFile(join(root, "ssh-stderr"), "ssh: connect to host 127.0.0.1 port 2222: Connection refused\n"); }
      if (scenario === "ssh-killed") await writeFile(join(root, "ssh-exit"), "137");
      const observed = await observe();
      expect(observed.stderr).toBe("");
      expect(observed).toMatchObject(scenario === "running" || scenario === "connection-refused"
        ? { exit: 3, result: { ok: false, state: "pending" } }
        : { exit: 4, result: { ok: false, state: "failed", error: { code: expect.any(String) } } });
      expect(observed.result.cloudInitComplete).not.toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
