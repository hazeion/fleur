import { appendFileSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

export interface Change {
  path: string;
  before: string | null;
  after: string | null;
  oldMode: string;
  newMode: string;
}
interface Scope { full: boolean; reason: string }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function workflowBehavior(text: string): unknown {
  const workflow: unknown = Bun.YAML.parse(text);
  if (!record(workflow) || !record(workflow.jobs)) throw new Error("Invalid workflow");
  // Never mutate parser-owned objects: YAML aliases may share metadata with
  // executable fields such as a later step's environment.
  const normalized = { ...workflow };
  delete normalized.concurrency;
  normalized.jobs = Object.fromEntries(Object.entries(workflow.jobs).map(([name, job]) => {
    if (!record(job) || !Array.isArray(job.steps)) throw new Error("Unsupported workflow shape");
    const steps = job.steps.map((step: unknown) => {
      if (!record(step) || typeof step.uses !== "string" || !step.uses.startsWith("actions/upload-artifact@") || !record(step.with)) return step;
      const parameters = { ...step.with };
      delete parameters["retention-days"];
      return { ...step, with: parameters };
    });
    return [name, { ...job, steps }];
  }));
  return normalized;
}
export function classifyChanges(changes: readonly Change[]): Scope {
  if (changes.length === 0) return { full: true, reason: "No complete change evidence" };
  for (const change of changes) {
    if (!["000000", "100644"].includes(change.oldMode) || !["000000", "100644"].includes(change.newMode))
      return { full: true, reason: "Nonregular or executable file change" };
    if (["README.md", "AGENTS.md", "CONTEXT.md", "docs/ci.md"].includes(change.path) || /^(docs\/planning|research)\/[^\0]+\.md$/.test(change.path)) continue;
    if (/^\.github\/workflows\/[^/]+\.yml$/.test(change.path) && change.before !== null && change.after !== null) {
      try {
        if (isDeepStrictEqual(workflowBehavior(change.before), workflowBehavior(change.after))) continue;
      } catch { /* Unreadable workflow changes require full verification. */ }
    }
    return { full: true, reason: "Behavior, verification, or unclassified file changed" };
  }
  return { full: false, reason: "Only allowlisted documentation or workflow concurrency/artifact retention changed" };
}
export function inspectPullRequest(cwd: string, base: string, head: string): Scope {
  try {
    if (![base, head].every((sha) => /^[0-9a-f]{40}$/.test(sha))) throw new Error("Invalid revision");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, timeout: 30000 });
      if (result.exitCode !== 0) throw new Error("Git evidence unavailable");
      return result.stdout.toString();
    };
    const ancestor = git("merge-base", base, head).trim();
    if (!/^[0-9a-f]{40}$/.test(ancestor)) throw new Error("Missing merge base");
    const fields = git("diff", "--no-ext-diff", "--no-textconv", "--raw", "-z", "--no-renames", "--no-abbrev", ancestor, head, "--").split("\0");
    if (fields.pop() !== "") throw new Error("Incomplete diff");
    const changes: Change[] = [];
    while (fields.length > 0) {
      const header = fields.shift(); const path = fields.shift();
      const match = header?.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [AMDT]$/);
      if (!match || !path) throw new Error("Unknown change record");
      const [, oldMode, newMode, before, after] = match;
      if (!oldMode || !newMode || !before || !after) throw new Error("Incomplete change record");
      const doc = ["README.md", "AGENTS.md", "CONTEXT.md", "docs/ci.md"].includes(path) || /^(docs\/planning|research)\/[^\0]+\.md$/.test(path);
      const contents = (sha: string) => /^0+$/.test(sha) ? null : doc ? "documentation" : git("cat-file", "blob", sha);
      changes.push({ path, oldMode, newMode, before: contents(before), after: contents(after) });
    }
    return classifyChanges(changes);
  } catch { return { full: true, reason: "Change evidence unavailable; full verification required" }; }
}
export function verifyResults(needs: unknown): boolean {
  if (!record(needs) || !record(needs.scope) || needs.scope.result !== "success" || !record(needs.scope.outputs)) return false;
  const full = needs.scope.outputs.full;
  if (full !== "true" && full !== "false") return false;
  const jobs = Object.entries(needs).filter(([name]) => name !== "scope");
  return jobs.length > 0 && jobs.every(([, job]) => record(job) && (job.result === "success" || (full === "false" && job.result === "skipped")));
}
if (import.meta.main) {
  if (process.argv.includes("--check-results")) {
    const needs: unknown = JSON.parse(process.env.NEEDS_JSON ?? "null");
    if (!verifyResults(needs)) throw new Error("Required CI scope or selected checks did not pass");
    console.log("All applicable checks passed. Nonapplicable matrix jobs, if any, are explicitly skipped, not runtime passes.");
  } else {
    let scope: Scope = { full: true, reason: "Push and manual runs always perform full verification" };
    if (process.env.GITHUB_EVENT_NAME === "pull_request") {
      const event: unknown = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"));
      if (record(event) && record(event.pull_request) && record(event.pull_request.base) && typeof event.pull_request.base.sha === "string")
        scope = inspectPullRequest(process.cwd(), event.pull_request.base.sha, process.env.GITHUB_SHA ?? "");
    }
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output destination");
    appendFileSync(process.env.GITHUB_OUTPUT, `full=${String(scope.full)}\n`);
    console.log(JSON.stringify(scope));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `CI scope: ${scope.full ? "full verification" : "documentation/workflow metadata only"}. ${scope.reason}.\n`);
  }
}
