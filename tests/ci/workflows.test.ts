import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

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
  expect(qualification.if).toBe("${{ github.event_name == 'workflow_dispatch' && (inputs.debian_helpers != '' || inputs.debian_recovery) && matrix.architecture == 'x86_64' }}");
  expect(qualification.run).toBe('python3 -I scripts/qualify-debian-kvm.py --run > "$RUNNER_TEMP/fleur-debian13-kvm.json"');
  expect(qualification.run).not.toContain("${{");
  expect(qualification.env).toEqual({ FLEUR_RUNNER_ENVIRONMENT: "${{ runner.environment }}", FLEUR_PINNED_BUN: "${{ runner.temp }}/fleur-native-bun/bun" });
  expect(native["timeout-minutes"]).toBe("${{ github.event_name == 'workflow_dispatch' && (inputs.debian_helpers != '' || inputs.debian_recovery || inputs.arch_boot_observation || inputs.desktop_runtime_images) && matrix.architecture == 'x86_64' && 40 || 10 }}");
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
  expect(workflow.jobs.verification?.needs).toEqual(["scope", "existing-docker"]);
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
