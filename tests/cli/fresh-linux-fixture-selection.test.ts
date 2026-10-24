import { expect, test } from "bun:test";
import { resolve } from "node:path";
async function observe(args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-fresh-linux.ts"), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000, env: { PATH: "", FLEUR_OWNED_DISPOSABLE_HOST: "yes" } });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exit, report: JSON.parse(stdout), stderr };
}
test("Ubuntu 26 verification selection reports exact fixed inputs without claiming execution or admission", async () => {
  const result = await observe(["--observe", "--fixture", "ubuntu26-amd64"]);
  expect(result.exit, result.stderr).toBe(4);
  expect(result.report).toMatchObject({ fixture: { id: "ubuntu26-amd64", catalogId: "ubuntu-26.04-amd64-docker-2026-10-19", catalogSha256: "e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a", image: { sha256: "5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5", size: 859090944 } }, executed: false, installationEvidence: "pending", runtimeSupport: "unverified" });
});
test.each(["ubuntu26-arm64", "debian13-arm64", "debian14-amd64", "../caller-profile.json"])("verification refuses unadmitted fixture %s before artifact reads", async (fixture) => {
  const result = await observe(["--run", "--image", "/missing-image", "--candidate", "source-owned", "--bun-archive", "/missing-bun", "--fixture", fixture]);
  expect(result.exit).toBe(4);
  expect(result.report.error.code).toBe("ARGUMENT_INVALID");
  expect(result.report.executed).toBe(false);
});
test("default verification preserves the frozen Ubuntu 24 input", async () => {
  const result = await observe(["--observe"]);
  expect(result.report.fixture).toMatchObject({ id: "ubuntu24-amd64", image: { sha256: "04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94", size: 621284352 } });
  expect(result.report.executed).toBe(false);
});
test("Ubuntu 26 refuses the Ubuntu 24 compiler closure before reading artifacts", async () => {
  const result = await observe(["--run", "--image", "/missing-image", "--candidate", "ordinary-source-owned", "--bun-archive", "/missing-bun", "--compiler-debs", "/missing-debs", "--fixture", "ubuntu26-amd64"]);
  expect(result.report.error).toMatchObject({ code: "ARGUMENT_INVALID", message: expect.stringContaining("recorded helper pair") });
  expect(result.report.executed).toBe(false);
});
test("a nonfinal fixture selector cannot alter verification policy", async () => {
  const result = await observe(["--fixture", "ubuntu26-amd64", "--observe"]);
  expect(result.report.error.code).toBe("ARGUMENT_INVALID");
  expect(result.report.executed).toBe(false);
});

test("Debian13 verification observation binds its exact image and internal catalog without execution", async () => {
  const result = await observe(["--observe", "--fixture", "debian13-amd64"]);
  expect(result.exit).toBe(4);
  expect(result.report.error.code).toBe("INFRASTRUCTURE_UNAVAILABLE");
  expect(result.report).toMatchObject({ fixture: { id: "debian13-amd64", catalogId: "debian-13-amd64-docker-2026-10-19", catalogSha256: "4dd2d26f6feb18768ac8cde10302006806f4f9a91c2bde59d8f96cb4744ce8f1", os: { id: "debian", versionId: "13" }, virtualSize: 3221225472, image: { sha256: "87211f082e2983a1c2209a2626f9f6762073a92c6a63a8ce321608ca496c3b02", size: 342818816 } }, executed: false, installationEvidence: "pending", runtimeSupport: "unverified" });
});

test("Debian13 refuses ordinary qualification before reading artifacts or launching tools", async () => {
  const result = await observe(["--run", "--image", "/missing-image", "--candidate", "ordinary-source-owned", "--bun-archive", "/missing-bun", "--recorded-helper-artifacts", "/missing-pair", "--fixture", "debian13-amd64"]);
  expect(result.report.error).toMatchObject({ code: "ARGUMENT_INVALID", message: expect.stringContaining("internal source-owned catalog") });
  expect(result.report.executed).toBe(false);
});

test("Debian13 refuses the Ubuntu compiler closure before reading artifacts", async () => {
  const result = await observe(["--run", "--image", "/missing-image", "--candidate", "source-owned", "--bun-archive", "/missing-bun", "--compiler-debs", "/missing-debs", "--fixture", "debian13-amd64"]);
  expect(result.report.error).toMatchObject({ code: "ARGUMENT_INVALID", message: expect.stringContaining("recorded helper pair") });
  expect(result.report.executed).toBe(false);
});
