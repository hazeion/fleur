import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyChanges, inspectPullRequest, verifyResults } from "../../scripts/ci-scope.ts";

const change = (path: string, before = "before", after = "after") => ({ path, before, after, oldMode: "100644", newMode: "100644" });
const workflow = "name: Example\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: bun test\n      - uses: actions/upload-artifact@fixed\n        with:\n          name: evidence\n          path: evidence/\n";

test("only explicit documentation paths avoid runtime verification", () => {
  expect(classifyChanges([change("README.md"), change("AGENTS.md"), change("docs/planning/V1-SPEC.md"), change("research/note.md")]).full).toBe(false);
  for (const path of ["src/main.ts", "package.json", "bun.lock", "lint/config.md", "docs/setup.md", "src/project/template/README.md", "tests/cli/example.test.ts", "scripts/ci-scope.ts", "tests/ci/scope.test.ts", "unexpected.md", ".github/actions/check/action.yml"])
    expect(classifyChanges([change(path)]).full, path).toBe(true);
  expect(classifyChanges([]).full).toBe(true);
  expect(classifyChanges([change("README.md"), change("src/main.ts")]).full).toBe(true);
});

test("metadata-only workflow changes can skip the matrix, executable changes cannot", () => {
  const after = workflow.replace("jobs:", "concurrency:\n  group: same-pr\n  cancel-in-progress: true\njobs:").replace("          path: evidence/", "          path: evidence/\n          retention-days: 7");
  expect(classifyChanges([change(".github/workflows/cli.yml", workflow, after)]).full).toBe(false);
  for (const text of [after.replace("bun test", "echo passed"), after.replace("ubuntu-24.04", "ubuntu-26.04"), after.replace("pull_request:", "push:"), after.replace("@fixed", "@moving"), after.replace("name: evidence", "name: different"), after + "permissions:\n  contents: write\n"])
    expect(classifyChanges([change(".github/workflows/cli.yml", workflow, text)]).full).toBe(true);
  expect(classifyChanges([change(".github/workflows/cli.yml", workflow, "invalid: [")]).full).toBe(true);
  expect(classifyChanges([{ ...change(".github/workflows/cli.yml"), before: null }]).full).toBe(true);
  expect(classifyChanges([{ ...change(".github/workflows/cli.yml"), after: null }]).full).toBe(true);
  expect(classifyChanges([{ ...change("README.md"), newMode: "120000" }]).full).toBe(true);
});

test("complete PR diff includes earlier runtime changes, renames, and more than 300 paths", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fleur-ci-scope-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    git("init", "--template=");
    git("config", "user.name", "CI fixture"); git("config", "user.email", "ci@example.invalid");
    writeFileSync(join(cwd, "README.md"), "initial"); writeFileSync(join(cwd, "app.ts"), "initial");
    git("add", "."); git("commit", "-m", "base"); const base = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "README.md"), "documentation"); git("add", "."); git("commit", "-m", "docs");
    expect(inspectPullRequest(cwd, base, git("rev-parse", "HEAD")).full).toBe(false);
    writeFileSync(join(cwd, "app.ts"), "runtime"); git("add", "."); git("commit", "-m", "runtime");
    mkdirSync(join(cwd, "research"));
    for (let index = 0; index < 305; index++) writeFileSync(join(cwd, "research", `note-${index}.md`), "note");
    git("mv", "app.ts", "README-renamed.md"); git("add", "."); git("commit", "-m", "later documentation");
    expect(inspectPullRequest(cwd, base, git("rev-parse", "HEAD")).full).toBe(true);
    expect(inspectPullRequest(cwd, "0".repeat(40), git("rev-parse", "HEAD")).full).toBe(true);
    expect(inspectPullRequest(cwd, "--help", "HEAD").full).toBe(true);
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("documentation");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 20000);

test("summary fails closed for failed scope, invalid outputs, or nonpassing required jobs", () => {
  const scope = (full: string) => ({ result: "success", outputs: { full } });
  expect(verifyResults({ scope: scope("false"), test: { result: "skipped" } })).toBe(true);
  expect(verifyResults({ scope: scope("true"), test: { result: "success" } })).toBe(true);
  for (const result of ["failure", "cancelled", "skipped"])
    expect(verifyResults({ scope: scope("true"), test: { result } })).toBe(false);
  expect(verifyResults({ scope: { result: "failure", outputs: { full: "false" } }, test: { result: "skipped" } })).toBe(false);
  expect(verifyResults({ scope: scope(""), test: { result: "skipped" } })).toBe(false);
  expect(verifyResults({ scope: scope("false"), test: { result: "failure" } })).toBe(false);
  expect(verifyResults({ scope: scope("false") })).toBe(false);
  expect(verifyResults({})).toBe(false);
});

test("workflow entry points force full checks for pushes/manual runs and reject broken summaries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fleur-ci-events-"));
  const script = new URL("../../scripts/ci-scope.ts", import.meta.url).pathname;
  try {
    for (const event of ["push", "workflow_dispatch"]) {
      const output = join(cwd, `${event}.txt`);
      const result = Bun.spawnSync([process.execPath, script], { cwd, env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" } });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("full=true\n");
    }
    const eventPath = join(cwd, "event.json"); writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: "0".repeat(40) } } }));
    const output = join(cwd, "pull-request.txt");
    const unknown = Bun.spawnSync([process.execPath, script], { cwd, env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: "1".repeat(40), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" } });
    expect(unknown.exitCode).toBe(0); expect(readFileSync(output, "utf8")).toBe("full=true\n");
    const failed = Bun.spawnSync([process.execPath, script, "--check-results"], { cwd, env: { ...process.env, NEEDS_JSON: JSON.stringify({ scope: { result: "failure" }, test: { result: "skipped" } }) } });
    expect(failed.exitCode).not.toBe(0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("artifact metadata shared through a YAML alias remains a runtime input", () => {
  const before = "name: Example\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/upload-artifact@fixed\n        with: &settings\n          retention-days: 7\n          name: evidence\n          path: evidence/\n      - run: bun test\n        env: *settings\n";
  const after = before.replace("retention-days: 7", "retention-days: 8");
  expect(classifyChanges([change(".github/workflows/cli.yml", before, after)]).full).toBe(true);
});
