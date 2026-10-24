import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Actual guest consumer, with disposable external command responses only.
for (const fault of ["binding", "backend", "canary", "service", "phase", "cleanup"]) {
  test(`Debian native qualification refuses an unsafe canary report: ${fault}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-debian-canary-refusal-"));
    try {
      const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
      const child = Bun.spawn([python, "-B", "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, `owned13-canary-${fault}`], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      const report = JSON.parse(stdout);
      expect(report.ok).toBe(false);
      expect(report.installationEvidence).toBe("pending");
      expect(report.runtimeSupport).toBe("unverified");
      expect(report.error.code).toBe("GUEST_VERIFICATION_FAILED");
      expect(report.error.message).toBe(fault === "canary" ? "Owned detached canary differs"
        : fault === "service" ? "nftables service execution or state differs" : "Original canary result binding differs");
      expect(report.debianDependencyPreservation.cleanup).toBe(false);
      const state = await Bun.file(join(root, "protocol-state.json")).json();
      expect(state.unexpected).toEqual([]);
      expect(state.canaryPhases).toEqual(fault === "cleanup" ? ["before", "afterInstall", "freshLogin", "afterRuntime", "cleanup"] : ["before", "afterInstall"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 65000);
}
