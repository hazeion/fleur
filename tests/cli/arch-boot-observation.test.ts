import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("Arch image and read-only observation contracts retain refusal and custody requirements", async () => {
  const child = Bun.spawn(["python3", "-I", "-m", "unittest", "discover", "-s", "scripts", "-p", "test_arch_boot*.py"], { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe", timeout: 20000 });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ out, code }).toEqual({ out: "", code: 0 });
  expect(error).toContain("OK");
});

test("Arch observer refuses a local host before interpreting an image", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/observe-arch-boot.ts"), "--run"], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(error).toBe(""); expect(code).toBe(4);
  expect(JSON.parse(out)).toMatchObject({ scope: "source-owned-arch-kvm-boot-observation", ok: false, executed: false, installationVerified: false, nativeQualification: false, runtimeAdmission: false });
});

test("Arch console diagnostics retain fixed boot pattern facts without publishing arbitrary text or bootstrap secrets", async () => {
  const { summarizeArchBootSerial } = await import("../../scripts/observe-arch-boot.ts");
  const secret = "PRIVATE-BOOTSTRAP-KEY-CONTENT";
  const text = `Linux version 6.17.1\n${secret}\n[FAILED] Failed to start secret-service-${secret}\n-----BEGIN OPENSSH PRIVATE KEY-----\n${secret}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const records = summarizeArchBootSerial([text]);
  expect(records).toEqual([{ decodedUtf8Sha256: Bun.CryptoHasher.hash("sha256", text, "hex"), decodedUtf8Bytes: Buffer.byteLength(text), patternMatches: [{ line: 1, pattern: "kernel-start" }, { line: 3, pattern: "systemd-failure" }], truncatedPatterns: false }]);
  expect(JSON.stringify(records)).not.toContain(secret);
  expect(JSON.stringify(records)).not.toContain("PRIVATE KEY");
});
