import { expect, test } from "bun:test";
import { resolve } from "node:path";
const fixture = resolve(import.meta.dir, "fixtures/recorded-disposal.ts");
// Successful guest data is protocol-only; the filesystem/process outcomes are real.
for (const mode of ["complete", "unreaped", "present", "unknown", "recovery"] as const) {
  test(`successful guest cannot bypass recorded disposal outcome ${mode}`, async () => {
    const child = Bun.spawn([process.execPath, fixture, mode], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const observed = JSON.parse(stdout);
    expect(observed.result.guest, stderr).toEqual({ ok: true });
    expect(exit, stderr + stdout).toBe(mode === "complete" ? 0 : 5);
    expect(observed.result.ok).toBe(mode === "complete");
    expect(observed.result.artifactDisposal.complete).toBe(mode === "complete");
    expect(observed.result.cleanup.credentialsRemoved).toBe(mode === "complete");
    if (mode === "complete") {
      expect(observed.result.artifactDisposal).toMatchObject({ vmReaped: true, removalAttempted: true, scratchRemoved: true, overlayRemoved: true });
      expect(observed.retained).toBeNull();
    } else {
      expect(observed.result.error.code).toBe("ARTIFACT_DISPOSAL_UNCONFIRMED");
      expect(observed.retained).toBe(mode === "present" ? "replacement retained" : "owned fixture payload");
    }
    if (mode === "unreaped") {
      expect(observed.ownedProcessStillLive).toBe(true);
      expect(observed.result.artifactDisposal).toMatchObject({ vmReaped: false, removalAttempted: false });
    }
    if (mode === "present") expect(observed.result.artifactDisposal).toMatchObject({ removalAttempted: true, scratchRemoved: false, overlayRemoved: false });
    if (mode === "unknown") expect(observed.result.artifactDisposal).toMatchObject({ removalAttempted: true, scratchRemoved: null, overlayRemoved: null });
    if (mode === "recovery") expect(observed.result.artifactDisposal.removalAttempted).toBe(false);
  }, 15000);
}
