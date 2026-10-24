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
  expect(native["timeout-minutes"]).toBe("${{ github.event_name == 'workflow_dispatch' && (inputs.debian_helpers != '' || inputs.debian_recovery) && matrix.architecture == 'x86_64' && 40 || 10 }}");
  expect(native.steps!.some((step) => step.run === "bun scripts/verify-native-setup.ts")).toBe(true);
  expect(workflow.jobs.verification).toBeDefined();
});
