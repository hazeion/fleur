import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("the actual guest command refuses a Resolute catalog on Ubuntu24 before setup authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-guest-crossed-catalog-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required for the OS-command fixture");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "crossed-catalog"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(false);
    expect(report.installationEvidence).toBe("pending");
    expect(report.error.message).toContain("candidate target");
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test("candidate metadata cannot replace its internal boolean with numeric admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-guest-marker-boolean-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required for the OS-command fixture");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "candidate-marker-boolean"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout).error.message).toContain("catalog metadata");
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.installed).toBe(false);
    expect(state.installPrompts).toEqual([]);
    expect(state.enrollmentPrompts).toEqual([]);
    expect(state.unexpected).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

for (const scenario of ["candidate-missing-catalog", "candidate-symlink-catalog", "candidate-self-rehashed-catalog", "candidate-artifact-mismatch", "candidate-missing-hash", "candidate-unknown-target"]) {
  test(`actual guest catalog authentication refuses ${scenario} before authority`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-guest-catalog-refusal-"));
    try {
      const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
      const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, scenario], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr + stdout).toBe(4);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, installationEvidence: "pending", runtimeSupport: "unverified" });
      const state = await Bun.file(join(root, "protocol-state.json")).json();
      expect(state.installed).toBe(false);
      expect(state.installPrompts).toEqual([]);
      expect(state.enrollmentPrompts).toEqual([]);
      expect(state.unexpected).toEqual([]);
      expect(await Bun.file(join(root, "lab/fresh-linux-state.json")).exists()).toBe(false);
      if (scenario === "candidate-symlink-catalog") expect(Bun.CryptoHasher.hash("sha256", await Bun.file(join(root, "retained-source-catalog.json")).arrayBuffer(), "hex")).toBe("540de9d76fc2aa8c260d1579a68c64ff0f1474b61cd332cfd428785432a56e58");
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 25000);
}
test("fresh login cannot switch the original source-owned candidate target before resume authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-guest-resume-catalog-"));
  try {
    const python = Bun.which("python3"); if (!python) throw new Error("Existing Python required");
    const child = Bun.spawn([python, "-I", resolve(import.meta.dir, "fixtures/fresh-linux-enrollment-main.py"), root, "resume-catalog-change"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr + stdout).toBe(4);
    expect(JSON.parse(stdout).error.message).toContain("candidate target");
    const state = await Bun.file(join(root, "protocol-state.json")).json();
    expect(state.installed).toBe(true);
    expect(state.enrollmentPrompts).toHaveLength(1);
    expect(state.staleReprobes).toBe(2);
    expect(state.unexpected).toEqual([]);
    expect(await Bun.file(join(root, "lab/fresh-linux-resume-started.json")).exists()).toBe(false);
    const first = await Bun.file(join(root, "first-session-report.json")).json();
    expect(first).toMatchObject({ phase: "new-login-required", ok: false, installationEvidence: "pending" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);
