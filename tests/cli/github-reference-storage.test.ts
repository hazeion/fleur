import { expect, test } from "bun:test";
import { githubStorageEvidence } from "../../scripts/github-reference-storage";

const commit = "a".repeat(40);
const identity = { commit, run: "10", attempt: "2", runner: "GitHub Actions 30" };
const run = { id: 10, run_attempt: 2, head_sha: commit, event: "workflow_dispatch", path: ".github/workflows/native-setup.yml", repository: { id: 1416288021, full_name: "hazeion/fleur", private: false } };
const job = { id: 20, run_id: 10, head_sha: commit, name: "Reference proof selection", status: "in_progress", labels: ["ubuntu-24.04-arm"], runner_id: 30, runner_name: identity.runner, runner_group_id: 0, runner_group_name: "GitHub Actions" };
const jobs = { total_count: 1, jobs: [job] };
const specification = '### Standard GitHub-hosted runners for public repositories\n<table><th scope="col"><b>Storage (SSD)</b></th><tr><td>Linux</td><td>4</td><td>16 GB</td><td>14 GB</td><td> arm64 </td><td><code>ubuntu-24.04-arm</code></td></tr></table>\n### Standard GitHub-hosted runners for private repositories';
const workflow = 'jobs:\n  reference-proof:\n    runs-on: ubuntu-24.04-arm\n';
test("control-plane-bound public standard runner freezes provider SSD provenance", () => {
  const evidence = githubStorageEvidence(identity, run, jobs, specification, workflow);
  expect(evidence.kind).toBe("GitHub-provisioned SSD"); expect(evidence.job).toBe(20);
  expect(evidence.specifications.sha256).toBe(Bun.CryptoHasher.hash("sha256", specification, "hex"));
  expect(evidence.runner.label).toBe("ubuntu-24.04-arm");
});
test("provider public section ends at the next heading despite private-heading whitespace", () => {
  const liveShape = specification.replace("### Standard GitHub-hosted runners for private repositories", "### Standard GitHub-hosted runners for  private repositories\n") + specification.split("\n")[1];
  expect(githubStorageEvidence(identity, run, jobs, liveShape, workflow).kind).toBe("GitHub-provisioned SSD");
});
test("missing, stale, private, self-hosted and ambiguous runner provenance cannot admit SSD storage", () => {
  for (const candidate of [
    { ...run, id: 11 }, { ...run, run_attempt: 1 }, { ...run, head_sha: "b".repeat(40) },
    { ...run, event: "pull_request" }, { ...run, path: "other.yml" },
    { ...run, repository: { ...run.repository, private: true } },
    { ...run, repository: { ...run.repository, id: 42 } },
    { ...run, repository: { ...run.repository, full_name: "attacker/fleur" } }, {},
  ]) expect(() => githubStorageEvidence(identity, candidate, jobs, specification, workflow)).toThrow();
  for (const candidate of [
    { ...job, head_sha: "b".repeat(40) }, { ...job, run_id: 11 }, { ...job, name: "other" },
    { ...job, status: "completed" }, { ...job, runner_name: "other" }, { ...job, runner_id: 0 },
    { ...job, labels: ["self-hosted", "ubuntu-24.04-arm"] }, { ...job, labels: ["ubuntu-24.04"] },
    { ...job, runner_group_id: 1 }, { ...job, runner_group_name: "self-hosted" },
  ]) expect(() => githubStorageEvidence(identity, run, { total_count: 1, jobs: [candidate] }, specification, workflow)).toThrow();
  for (const candidate of [{ total_count: 2, jobs: [job] }, { total_count: 2, jobs: [job, job] }, { total_count: 0, jobs: [] }]) expect(() => githubStorageEvidence(identity, run, candidate, specification, workflow)).toThrow();
});
test("provider specification and committed runner selection must both establish the exact SSD profile", () => {
  for (const candidate of ["", specification.replace("(SSD)", "(HDD)"), specification.replace("16 GB", "8 GB"), specification.replace("public repositories", "private repositories"), specification.replace("ubuntu-24.04-arm", "ubuntu-24.04"), specification + specification]) expect(() => githubStorageEvidence(identity, run, jobs, candidate, workflow)).toThrow();
  expect(() => githubStorageEvidence(identity, run, jobs, specification, workflow.replace("ubuntu-24.04-arm", "self-hosted"))).toThrow();
});
