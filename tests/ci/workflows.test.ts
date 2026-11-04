import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bunFloor } from "../../src/project/release.ts";

interface Job { needs?: string | string[]; if?: string; steps?: { run?: string }[] }
interface Workflow { on: Record<string, unknown>; jobs: Record<string, Job> }
for (const name of ["cli", "native-setup", "compatibility"]) {
  test(`${name} always reports scope and fails closed across every selected job`, () => {
    const workflow = Bun.YAML.parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8")) as Workflow;
    expect(workflow.on).toHaveProperty("pull_request");
    const { scope, verification, ...jobs } = workflow.jobs;
    expect(scope?.steps?.some((step) => step.run?.includes("bun test tests/ci"))).toBe(true);
    expect(scope?.steps?.some((step) => step.run?.includes("bun scripts/ci-scope.ts"))).toBe(true);
    expect(verification?.if).toBe("${{ always() }}");
    expect(verification?.needs).toEqual(["scope", ...Object.keys(jobs)]);
    expect(verification?.steps?.some((step) => step.run?.includes("bun scripts/ci-scope.ts --check-results"))).toBe(true);
    for (const job of Object.values(jobs)) {
      expect(job.needs).toBe("scope");
      expect(job.if).toBe("${{ needs.scope.outputs.full == 'true' }}");
    }
  });
}

test("fresh Debian qualification is explicit manual x64 work and cannot bypass the native summary", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/native-setup.yml", import.meta.url), "utf8")) as {
    on: { workflow_dispatch: { inputs: { debian_helpers: { type: string; required: boolean; default: string }; debian_recovery: { description: string; type: string; required: boolean; default: boolean } } } };
    jobs: Record<string, { "timeout-minutes"?: string; steps?: { name?: string; if?: string; run?: string; env?: Record<string, string> }[] }>;
  };
  expect(workflow.on.workflow_dispatch.inputs.debian_helpers).toMatchObject({ type: "string", required: false, default: "" });
  expect(workflow.on.workflow_dispatch.inputs.debian_recovery).toEqual({ description: "Run the fixed Debian interrupted-recovery case; requires debian_helpers", type: "boolean", required: false, default: false });
  const native = workflow.jobs["existing-docker"]!;
  const qualification = native.steps!.find((step) => step.name === "Fresh Debian 13 native KVM qualification")!;
  expect(qualification.if).toBe("${{ github.event_name == 'workflow_dispatch' && (inputs.debian_helpers != '' || inputs.debian_recovery || inputs.workout_proof) && matrix.architecture == 'x86_64' }}");
  expect(qualification.run).toBe('python3 -I scripts/qualify-debian-kvm.py --run > "$RUNNER_TEMP/fleur-debian13-kvm.json"');
  expect(qualification.run).not.toContain("${{");
  expect(qualification.env).toEqual({ FLEUR_RUNNER_ENVIRONMENT: "${{ runner.environment }}", FLEUR_PINNED_BUN: "${{ runner.temp }}/fleur-native-bun/bun" });
  expect(native["timeout-minutes"]).toBe("${{ github.event_name == 'workflow_dispatch' && (inputs.debian_helpers != '' || inputs.debian_recovery || inputs.arch_boot_observation || inputs.desktop_runtime_images || inputs.workout_proof) && matrix.architecture == 'x86_64' && 40 || 10 }}");
  expect(native.steps!.some((step) => step.run === "bun scripts/verify-native-setup.ts")).toBe(true);
  expect(workflow.jobs.verification).toBeDefined();
});


test("Arch boot observation is a closed manual x64 diagnostic and retains ordinary ARM and summary checks", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/native-setup.yml", import.meta.url), "utf8")) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean; required: boolean }> } };
    jobs: Record<string, { needs?: unknown; strategy?: { matrix: { include: { runner: string; architecture: string }[] } }; steps?: { name?: string; if?: string; run?: string; with?: { path?: string } }[] }>;
  };
  expect(workflow.on.workflow_dispatch.inputs.arch_boot_observation).toMatchObject({ type: "boolean", default: false, required: false });
  const native = workflow.jobs["existing-docker"]!;
  const step = native.steps!.find((item) => item.name === "Read-only Arch native KVM boot observation")!;
  expect(step.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.arch_boot_observation && matrix.architecture == 'x86_64' }}");
  expect(step.run).toBe('python3 -I scripts/qualify-debian-kvm.py --run > "$RUNNER_TEMP/fleur-arch-kvm-boot.json"');
  expect(step.run).not.toContain("${{");
  expect(native.strategy?.matrix.include).toContainEqual({ runner: "ubuntu-24.04-arm", architecture: "arm64" });
  expect(native.steps!.find((item) => item.name === "Preserve native observations")?.with?.path).toContain("fleur-arch-kvm-boot.json");
  expect(workflow.jobs.verification?.needs).toEqual(["scope", "existing-docker", "reference-proof"]);
});

test("Desktop image preparation uses only explicit manual native x64 work and retains all verification", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/native-setup.yml", import.meta.url), "utf8")) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean; required: boolean }> } };
    jobs: Record<string, { "timeout-minutes"?: string; steps?: { name?: string; if?: string; run?: string; with?: { path?: string; "retention-days"?: number } }[] }>;
  };
  expect(workflow.on.workflow_dispatch.inputs.desktop_runtime_images).toMatchObject({ type: "boolean", default: false, required: false });
  const native = workflow.jobs["existing-docker"]!;
  const step = native.steps!.find((item) => item.name === "Prepare native Desktop runtime image inputs")!;
  expect(step.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.desktop_runtime_images && matrix.architecture == 'x86_64' }}");
  expect(step.run).toBe('python3 experiments/compatibility/desktop-runtime/export_images.py --output "$RUNNER_TEMP/fleur-desktop-images"');
  expect(step.run).not.toContain("${{");
  expect(native.steps!.some((item) => item.run === "bun scripts/verify-native-setup.ts")).toBe(true);
  expect(native.steps!.find((item) => item.name === "Preserve native observations")?.with?.path).toContain("fleur-desktop-images/");
  expect(native.steps!.find((item) => item.name === "Preserve native observations")?.with?.["retention-days"]).toBe(7);
});

test("the read-runtime job pulls the pinned development images before the runtime tests", async () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/cli.yml", import.meta.url), "utf8")) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> };
  const production = "tests/runtime/production-artifact.integration.test.ts";
  // The artifact test moved to its own job: it must run exactly there, with the same prerequisites.
  for (const [job, command] of [["read-runtime", `bun test tests/runtime --path-ignore-patterns=${production}`], ["production-artifact", `bun test ${production}`]] as const) {
    const steps = workflow.jobs[job]!.steps!;
    const pull = steps.findIndex((step) => step.run === "bun scripts/pull-pinned-development-images.ts");
    const runtime = steps.findIndex((step) => step.run === command);
    expect(pull, job).toBeGreaterThan(-1);
    expect(runtime, job).toBeGreaterThan(pull);
  }
  // One source of truth: the script reads the compiled smoke and PostgreSQL pins rather than repeating digests.
  const script = readFileSync(new URL("../../scripts/pull-pinned-development-images.ts", import.meta.url), "utf8");
  expect(script).toContain("smokeImages");
  expect(script).toContain("developmentPostgresImage");
  expect(script).not.toMatch(/sha256:[a-f0-9]{64}/);
});

// The Bun floor (CONTEXT.md "Version floor") is declared once in package.json `engines.bun`. CI and the
// fresh-Linux verifiers install exactly that release, so its version and official archive digests live in one
// record that Python and TypeScript read without a build step. Raising the floor is a record update, not a hunt.
const repository = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repository), "utf8");
interface FloorRecord { formatVersion: 1; version: string; archives: Record<string, { name: string; sha256: string }> }
const floorRecord = (): FloorRecord => JSON.parse(read("scripts/bun-floor.json")) as FloorRecord;

test("the Bun floor record equals engines.bun and names one official archive digest per supported platform", () => {
  const record = floorRecord();
  expect(record.formatVersion).toBe(1);
  expect(record.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(`>=${record.version}`).toBe(bunFloor);
  expect(Object.keys(record.archives).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
  for (const [platform, archive] of Object.entries(record.archives)) {
    const [os, arch] = platform.split("-");
    expect(archive.name, platform).toBe(`bun-${os}-${arch === "arm64" ? "aarch64" : arch}`);
    expect(archive.sha256, platform).toMatch(/^[a-f0-9]{64}$/);
  }
});

test("every Bun installer, verifier and fixture reads the floor record instead of repeating its version or digests", () => {
  const record = floorRecord();
  const readers = [
    "experiments/compatibility/platforms/bootstrap.py", "scripts/qualify-debian-kvm.py", "scripts/verify-fresh-linux.ts", "scripts/verify-debian-recovery.ts",
    "scripts/observe-fresh-linux-preparation.ts", "scripts/fresh-linux-guest.py", "scripts/prepare-fresh-linux-guest.py",
    "tests/cli/guest-preparation.test.ts", "tests/cli/fresh-linux-preparation.test.ts", "tests/cli/fixtures/fresh-linux-enrollment-main.py",
    "experiments/compatibility/tooling/run.py", "experiments/compatibility/tooling/test_runner.py", "experiments/compatibility/database-broker/run.py",
    "experiments/compatibility/database-broker/native.py", "experiments/compatibility/runtime-probe/run.py",
  ];
  for (const path of readers) {
    const source = read(path);
    expect(source, path).toContain("bun-floor.json");
    expect(source, path).not.toMatch(/bun-v\d/);
    expect(source, path).not.toMatch(new RegExp(`["']${record.version.replaceAll(".", "\\.")}["']`));
    for (const archive of Object.values(record.archives)) expect(source, path).not.toContain(archive.sha256);
  }
  // Installers install a machine tool at the floor; they do not express the admission rule, so the message names the floor.
  expect(read("experiments/compatibility/platforms/bootstrap.py")).toContain("installed Bun differs from the release floor");
  expect(read("experiments/compatibility/platforms/bootstrap.py")).not.toContain("exact pin");
});

test("every CI job that runs Bun installs exactly the floor release first and no workflow installs a different Bun", () => {
  const record = floorRecord();
  for (const name of ["cli", "native-setup", "compatibility"]) {
    const text = read(`.github/workflows/${name}.yml`);
    expect(text, name).not.toMatch(/bun-v\d/);
    expect(text, name).not.toMatch(/setup-bun|bun-version|bun\.sh\/install/);
    for (const archive of Object.values(record.archives)) expect(text, name).not.toContain(archive.sha256);
    expect(text, name).not.toContain(`= ${record.version}`);
    const workflow = Bun.YAML.parse(text) as { jobs: Record<string, { steps?: { uses?: string; run?: string }[] }> };
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      const steps = definition.steps ?? [];
      const provides = (run = "") => run.includes("experiments/compatibility/platforms/bootstrap.py") || run.includes("releases/download/bun-");
      const provider = steps.findIndex((step) => provides(step.run));
      for (const [index, step] of steps.entries()) {
        const run = step.run ?? "";
        if (run.includes("releases/download/bun-")) {
          // A direct download derives the release and its digest from the record at run time, then checks the exact version.
          expect(run, `${name}/${job}`).toContain("scripts/bun-floor.json");
          expect(run, `${name}/${job}`).toContain("/bun-v$floor/");
          expect(run, `${name}/${job}`).toContain('--version)" = "$floor"');
          expect(run, `${name}/${job}`).toContain('"$sha256  ');
        }
        // Any step invoking Bun from PATH or an owned path runs after this job's floor installation.
        if (/(^|[\s(;&|"])bun\s/m.test(run) || run.includes("FLEUR_EXPERIMENT_BUN") || run.includes("fleur-bun/")) {
          expect(provider, `${name}/${job} step ${index}`).toBeGreaterThanOrEqual(0);
          expect(index, `${name}/${job} step ${index}`).toBeGreaterThanOrEqual(provider);
        }
      }
    }
  }
});

test("reference qualification is an explicit manual workload with retained raw evidence and required summary", () => {
  const workflow = Bun.YAML.parse(read(".github/workflows/native-setup.yml")) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean }> } };
    jobs: Record<string, { needs?: string[]; "timeout-minutes"?: number; steps?: { name?: string; if?: string; run?: string; with?: Record<string, unknown> }[] }>;
  };
  expect(workflow.on.workflow_dispatch.inputs.reference_proof).toMatchObject({ type: "boolean", default: false });
  const job = workflow.jobs["reference-proof"]!;
  expect(job).toBeDefined();
  expect(job["timeout-minutes"]).toBe(120);
  const selection = "${{ github.event_name == 'workflow_dispatch' && inputs.reference_proof }}";
  const proof = job.steps!.find(step => step.run?.includes("scripts/verify-workout.ts"))!;
  expect(proof.if).toBe(selection);
  expect(proof.run).toContain('--reference > "$RUNNER_TEMP/workout-proof.json"');
  for (const step of job.steps!.filter(step => step.name !== "Reference proof selection")) expect(step.if).toBe(step.name === "Retain sanitized qualification evidence" ? "${{ always() && github.event_name == 'workflow_dispatch' && inputs.reference_proof }}" : selection);
  expect(workflow.jobs.verification!.needs).toContain("reference-proof");
  const artifact = job.steps!.find(step => step.name === "Retain sanitized qualification evidence")!;
  expect(artifact.with?.["retention-days"]).toBe(7);
  expect(artifact.with?.path).toContain("fleur/test-results/workout-reference.json");
});

test("required native workout proof uses immutable private source and keeps its read credential in checkout", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/cli.yml", import.meta.url), "utf8")) as {
    jobs: Record<string, { strategy?: { matrix: { ubuntu: string[] } }; steps?: { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }[] }>;
  };
  const job = workflow.jobs["workout-proof"]!;
  expect(job.strategy?.matrix.ubuntu).toEqual(["24.04", "26.04"]);
  const steps = job.steps!;
  const checkout = steps.find(step => step.with?.repository === "hazeion/fleur-workout")!;
  expect(checkout.with?.["persist-credentials"]).toBe(false);
  expect(checkout.with?.["ssh-key"]).toBe("${{ secrets.FLEUR_WORKOUT_READ_KEY }}");
  expect(checkout.with?.ref).toBe("${{ steps.workout.outputs.sha }}");
  for (const step of steps) {
    expect(step.run ?? "").not.toContain("FLEUR_WORKOUT_READ_KEY");
    expect(JSON.stringify(step.env ?? {})).not.toContain("FLEUR_WORKOUT_READ_KEY");
  }
  expect(steps.some(step => step.run?.includes('bun scripts/verify-workout.ts "$GITHUB_WORKSPACE/workout"'))).toBe(true);
  const pin = JSON.parse(readFileSync(new URL("../../scripts/workout-source.json", import.meta.url), "utf8"));
  expect(pin.repository).toBe("hazeion/fleur-workout"); expect(pin.commit).toMatch(/^[a-f0-9]{40}$/);
});

test("native Debian workout remains an explicit manual case with an isolated read-only source checkout", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../../.github/workflows/native-setup.yml", import.meta.url), "utf8")) as {
    on: { workflow_dispatch: { inputs: Record<string, { type: string; default: boolean }> } };
    jobs: Record<string, { steps: { if?: string; with?: Record<string, unknown> }[] }>;
  };
  expect(workflow.on.workflow_dispatch.inputs.workout_proof).toMatchObject({ type: "boolean", default: false });
  const checkout = workflow.jobs["existing-docker"]!.steps.find(step => step.with?.repository === "hazeion/fleur-workout")!;
  expect(checkout.if).toBe("${{ github.event_name == 'workflow_dispatch' && inputs.workout_proof && matrix.architecture == 'x86_64' }}");
  expect(checkout.with?.["persist-credentials"]).toBe(false);
  expect(checkout.with?.["ssh-key"]).toBe("${{ secrets.FLEUR_WORKOUT_READ_KEY }}");
});
