import assert from "node:assert/strict";
import { z } from "zod";

const repository = "hazeion/fleur";
const workflow = ".github/workflows/native-setup.yml";
const label = "ubuntu-24.04-arm";
export const runnerSpecifications = "https://docs.github.com/en/actions/reference/runners/github-hosted-runners";
const specificationsBody = "https://docs.github.com/api/article/body?pathname=/en/actions/reference/runners/github-hosted-runners";
const integer = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
interface Identity { commit: string; run: string; attempt: string; runner: string }

/** Trusted benchmark evidence, never an application-supplied storage override. */
export function githubStorageEvidence(identity: Identity, runInput: unknown, jobsInput: unknown, specification: string, sourceWorkflow: string) {
  const run = z.object({ id: integer, run_attempt: integer, head_sha: sha, event: z.literal("workflow_dispatch"), path: z.literal(workflow), repository: z.object({ id: z.literal(1416288021), full_name: z.literal(repository), private: z.literal(false) }) }).parse(runInput);
  assert.equal(String(run.id), identity.run); assert.equal(String(run.run_attempt), identity.attempt); assert.equal(run.head_sha, identity.commit);
  const jobs = z.object({ total_count: integer, jobs: z.array(z.object({ id: integer, run_id: integer, head_sha: sha, name: z.string(), status: z.string(), labels: z.array(z.string()), runner_id: integer, runner_name: z.string(), runner_group_id: z.number().int().nonnegative(), runner_group_name: z.string() })).max(100) }).parse(jobsInput);
  assert.equal(jobs.jobs.length, jobs.total_count, "Incomplete control-plane job inventory");
  const selected = jobs.jobs.filter(job => job.name === "Reference proof selection");
  assert.equal(selected.length, 1, "Ambiguous reference job identity");
  const job = selected[0]!;
  assert.equal(job.run_id, run.id); assert.equal(job.head_sha, identity.commit); assert.equal(job.status, "in_progress");
  assert.equal(job.runner_name, identity.runner); assert.equal(job.runner_group_id, 0); assert.equal(job.runner_group_name, "GitHub Actions");
  assert.deepEqual(job.labels, [label]);
  const definition = (Bun.YAML.parse(sourceWorkflow) as { jobs: Record<string, { "runs-on": string }> }).jobs["reference-proof"];
  assert.equal(definition?.["runs-on"], label, "Source workflow does not bind the standard runner");
  const sections = specification.split("### Standard GitHub-hosted runners for public repositories");
  assert.equal(sections.length, 2, "Provider public runner section is ambiguous");
  const publicSection = sections[1]?.split(/\n###\s/)[0];
  assert.ok(publicSection && /<th[^>]*>\s*<b>Storage \(SSD\)<\/b>\s*<\/th>/.test(publicSection), "Provider SSD specification unavailable");
  const rows = [...publicSection.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => [...row[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => cell[1]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()));
  const row = rows.filter(cells => cells[5]?.split(/[ ,]+/).includes(label));
  assert.equal(row.length, 1, "Provider runner specification is ambiguous");
  assert.deepEqual(row[0]!.slice(0, 5), ["Linux", "4", "16 GB", "14 GB", "arm64"]);
  return { kind: "GitHub-provisioned SSD" as const, specifications: { url: runnerSpecifications, retrievedAt: new Date().toISOString(), sha256: Bun.CryptoHasher.hash("sha256", specification, "hex"), row: row[0]! }, repository: run.repository, workflow: run.path, source: run.head_sha, run: run.id, attempt: run.run_attempt, job: job.id, runner: { id: job.runner_id, name: job.runner_name, group: job.runner_group_name, label } };
}

export async function observeGithubStorage(commit: string, sourceWorkflow: string) {
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_REPOSITORY, repository); assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_JOB, "reference-proof"); assert.equal(process.env.RUNNER_OS, "Linux"); assert.equal(process.env.RUNNER_ARCH, "ARM64");
  assert.equal(process.env.GITHUB_SHA, commit);
  const run = z.string().regex(/^[1-9][0-9]{0,15}$/).parse(process.env.GITHUB_RUN_ID);
  const attempt = z.string().regex(/^[1-9][0-9]{0,5}$/).parse(process.env.GITHUB_RUN_ATTEMPT);
  const runner = z.string().min(1).max(256).parse(process.env.RUNNER_NAME);
  const get = async (url: string) => {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10000), headers: { accept: "application/vnd.github+json" } });
    assert.equal(response.ok, true, "Provider evidence could not be retrieved");
    const body = await response.text(); assert.ok(Buffer.byteLength(body) < 1024 * 1024, "Provider evidence exceeds bound"); return body;
  };
  const base = `https://api.github.com/repos/${repository}/actions/runs/${run}`;
  const [runBody, jobsBody, specification] = await Promise.all([get(base), get(`${base}/attempts/${attempt}/jobs?per_page=100`), get(specificationsBody)]);
  return githubStorageEvidence({ commit, run, attempt, runner }, JSON.parse(runBody), JSON.parse(jobsBody), specification, sourceWorkflow);
}
