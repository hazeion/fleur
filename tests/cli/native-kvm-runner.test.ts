import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("manual native KVM input and disposal gates reject altered or incomplete evidence", async () => {
  const child = Bun.spawn(["python3", "-I", resolve(import.meta.dir, "../../scripts/test_qualify_debian_kvm.py")], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, error, code }).toMatchObject({ out: "", code: 0 });
  expect(error).toContain("Ran 21 tests");
});

test("manual native KVM qualification refuses a local host before privileged commands", async () => {
  const child = Bun.spawn(["python3", "-I", resolve(import.meta.dir, "../../scripts/qualify-debian-kvm.py"), "--run"], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(4);
  expect(error).toBe("");
  expect(JSON.parse(out)).toMatchObject({ ok: false, scope: "manual-native-debian13-kvm", runtimeAdmission: false, error: { message: "Fixed hosted runner context unavailable" } });
});
