import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const script = resolve(import.meta.dir, "../../scripts/verify-fresh-linux.ts");
async function invoke(args: string[], accelerator?: string) {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-host-policy-"));
  try {
    const child = Bun.spawn([process.execPath, script, ...args], { env: { HOME: scratch, PATH: scratch, FLEUR_OWNED_DISPOSABLE_HOST: "yes", ...(accelerator === undefined ? {} : { FLEUR_GUEST_ACCELERATOR: accelerator }) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { report: JSON.parse(stdout), stderr, exit };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
for (const value of ["hvf", "tcg:kvm", "", "invalid"]) {
  test(`invalid accelerator grammar is rejected before artifact or tool access: ${JSON.stringify(value)}`, async () => {
    const result = await invoke(["--run", "--image", "/unavailable-image", "--candidate", "source-owned", "--bun-archive", "/unavailable-bun"], value);
    expect(result.exit).toBe(4);
    expect(result.report).toMatchObject({ executed: false, ok: false, error: { code: "ARGUMENT_INVALID" } });
    expect(result.stderr).toBe("");
  });
}

test("observation identifies the actual verification host policy without claiming native CPU proof", async () => {
  const result = await invoke(["--observe"]);
  expect(result.exit).toBe(4);
  expect(result.report.capabilities.hostPolicy).toEqual(process.platform === "darwin" && process.arch === "x64"
    ? { admitted: true, seedBuilder: "hdiutil", accelerators: ["tcg"] }
    : process.platform === "linux" && process.arch === "x64"
      ? { admitted: true, seedBuilder: "cloud-localds", accelerators: ["tcg", "kvm"] }
      : { admitted: false, seedBuilder: null, accelerators: [] });
  expect(result.report.nativeCpuPerformanceProof).toBe(false);
  expect(result.report.capabilities.system).toBe(process.platform);
});

test("Darwin refuses KVM before artifact access while Linux retains artifact authentication", async () => {
  const result = await invoke(["--run", "--image", "/unavailable-image", "--candidate", "source-owned", "--bun-archive", "/unavailable-bun"], "kvm");
  expect(result.exit).toBe(4);
  expect(result.report.executed).toBe(false);
  expect(result.report.error.code).toBe(process.platform === "darwin" ? "HOST_ACCELERATOR_UNSUPPORTED" : "ENOENT");
});
