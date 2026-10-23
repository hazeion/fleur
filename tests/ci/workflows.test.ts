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
