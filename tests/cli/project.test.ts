import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { projectCommands } from "../../src/project/commands.ts";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await realpath(await mkdtemp(join(tmpdir(), "fleur-creation-"))); roots.push(value); return value; }
test("new creates an exactly pinned project through the command boundary", async () => {
  const cwd = await root();
  const outcome = await runCli(["new", "sample", "--no-git", "--json"], { cwd, handlers: projectCommands });
  expect(outcome.exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(cwd, "sample", "fleur.json"), "utf8"))).toMatchObject({ fleurVersion: "0.1.0", compiler: "microsoft" });
  expect(outcome.result).toMatchObject({ formatVersion: 1, command: "new", ok: true, error: null });
});

test("init preserves existing user files and appends marked guidance while creating the approved layout", async () => {
  const cwd = await root();
  for (const name of ["README.md", "LICENSE", ".private", "AGENTS.md", "CLAUDE.md"]) await writeFile(join(cwd, name), `User ${name}\n`);
  const outcome = await runCli(["init", "--no-git"], { cwd, handlers: projectCommands });
  expect(outcome.exitCode).toBe(0);
  for (const name of ["README.md", "LICENSE", ".private"]) expect(await readFile(join(cwd, name), "utf8")).toBe(`User ${name}\n`);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(cwd, name), "utf8");
    expect(text).toStartWith(`User ${name}\n`);
    expect(text).toContain("<!-- fleur:generated:start version=0.1.0 -->");
  }
  expect(await readdir(cwd)).toEqual(expect.arrayContaining(["client", "server", "shared", "assets", "tests", "migrations", "seeds", "package.json", "bun.lock"]));
  expect(await readFile(join(cwd, ".agents/skills/fleur-tdd/SKILL.md"), "utf8")).toContain("red");
});
test("a protected file collision leaves the existing directory completely unchanged", async () => {
  const cwd = await root();
  await writeFile(join(cwd, "package.json"), '{"name":"user-project"}\n');
  await writeFile(join(cwd, "AGENTS.md"), "User instructions\n");
  const before = await readdir(cwd);
  const outcome = await runCli(["init", "--no-git"], { cwd, handlers: projectCommands });
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("PROJECT_COLLISION");
  expect(await readdir(cwd)).toEqual(before);
  expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("User instructions\n");
});
test("creation initializes Git without a commit and never nests a repository", async () => {
  const cwd = await root();
  const fresh = await runCli(["new", "fresh"], { cwd, handlers: projectCommands });
  expect(fresh.exitCode).toBe(0);
  expect(await Bun.file(join(cwd, "fresh", ".git", "HEAD")).exists()).toBe(true);
  const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], { cwd: join(cwd, "fresh"), stdout: "pipe", stderr: "pipe" });
  expect(head.exitCode).not.toBe(0);
  const nested = await runCli(["new", "nested"], { cwd: join(cwd, "fresh"), handlers: projectCommands });
  expect(nested.exitCode).toBe(0);
  expect(await Bun.file(join(cwd, "fresh", "nested", ".git", "HEAD")).exists()).toBe(false);
});

test("a failed external Git action rolls back only created files and restores user guidance", async () => {
  const cwd = await root();
  const commands = join(cwd, "commands");
  await mkdir(commands);
  await writeFile(join(commands, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const target = join(cwd, "project");
  await mkdir(target);
  await writeFile(join(target, "AGENTS.md"), "Keep this instruction exactly\n");
  await writeFile(join(target, ".hidden"), "Keep hidden\n");
  const previous = process.env.PATH;
  process.env.PATH = commands;
  let outcome;
  try { outcome = await runCli(["init"], { cwd: target, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(outcome.exitCode).toBe(1);
  expect(outcome.result.error?.code).toBe("PROJECT_CREATION_FAILED");
  expect(await readdir(target)).toEqual([".hidden", "AGENTS.md"]);
  expect(await readFile(join(target, "AGENTS.md"), "utf8")).toBe("Keep this instruction exactly\n");
});

test("creation refuses symlink ancestors and guidance without writing through them", async () => {
  const cwd = await root();
  await mkdir(join(cwd, "outside"));
  await symlink(join(cwd, "outside"), join(cwd, "linked"));
  const outcome = await runCli(["new", "linked/project", "--no-git"], { cwd, handlers: projectCommands });
  expect(outcome.exitCode).toBe(5);
  expect(await readdir(join(cwd, "outside"))).toEqual([]);
  const target = join(cwd, "project"); await mkdir(target);
  await writeFile(join(cwd, "user-guidance"), "Never change this\n");
  await symlink(join(cwd, "user-guidance"), join(target, "AGENTS.md"));
  const guidance = await runCli(["init", "--no-git"], { cwd: target, handlers: projectCommands });
  expect(guidance.exitCode).toBe(5);
  expect(await readdir(target)).toEqual(["AGENTS.md"]);
  expect(await readFile(join(cwd, "user-guidance"), "utf8")).toBe("Never change this\n");
});
test("compiler choices use the verified Microsoft toolchain and reject unavailable Rust before writes", async () => {
  const cwd = await root();
  const microsoft = await runCli(["new", "microsoft", "--compiler", "microsoft", "--no-git"], { cwd, handlers: projectCommands });
  expect(microsoft.exitCode).toBe(0);
  const rust = await runCli(["new", "rust", "--compiler", "rust-experimental", "--no-git"], { cwd, handlers: projectCommands });
  expect(rust.exitCode).toBe(4);
  expect(rust.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
  expect(await readdir(cwd)).toEqual(["microsoft"]);
  const invalid = await runCli(["new", "invalid", "--compiler", "unknown", "--no-git"], { cwd, handlers: projectCommands });
  expect(invalid.exitCode).toBe(2);
});
test("creation bounds a stalled Git action by the command timeout and restores files", async () => {
  const cwd = await root(); const commands = join(cwd, "commands"); await mkdir(commands);
  await writeFile(join(commands, "git"), "#!/bin/sh\nexec /bin/sleep 2\n", { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = commands;
  const started = performance.now(); let outcome;
  try { outcome = await runCli(["new", "project", "--timeout", "0.05"], { cwd, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(performance.now() - started).toBeLessThan(1500);
  expect(outcome.exitCode).toBe(1);
  expect(await readdir(cwd)).toEqual(["commands"]);
});
test("existing generated guidance requires resolution and repeated init never duplicates it", async () => {
  const cwd = await root();
  await writeFile(join(cwd, "AGENTS.md"), "User\n<!-- fleur:generated:start version=0.1.0 -->\nedited\n<!-- fleur:generated:end -->\n");
  const original = await readFile(join(cwd, "AGENTS.md"));
  const blocked = await runCli(["init", "--no-git"], { cwd, handlers: projectCommands });
  expect(blocked.exitCode).toBe(5);
  expect(await readdir(cwd)).toEqual(["AGENTS.md"]);
  expect(await readFile(join(cwd, "AGENTS.md"))).toEqual(original);
  const fresh = await root();
  expect((await runCli(["init", "--no-git"], { cwd: fresh, handlers: projectCommands })).exitCode).toBe(0);
  const guidance = await readFile(join(fresh, "AGENTS.md"));
  expect((await runCli(["init", "--no-git"], { cwd: fresh, handlers: projectCommands })).exitCode).toBe(5);
  expect(await readFile(join(fresh, "AGENTS.md"))).toEqual(guidance);
});
test("partial Git metadata is reported for recovery and never recursively deleted", async () => {
  const cwd = await root(); const commands = join(cwd, "commands"); await mkdir(commands);
  await writeFile(join(commands, "git"), '#!/bin/sh\n/bin/mkdir "$6/.git"\nprintf user > "$6/.git/unexpected"\nexit 1\n', { mode: 0o755 });
  const target = join(cwd, "project"); await mkdir(target);
  const previous = process.env.PATH; process.env.PATH = commands; let outcome;
  try { outcome = await runCli(["init"], { cwd: target, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(await readFile(join(target, ".git", "unexpected"), "utf8")).toBe("user");
  expect(outcome.result.error?.actual).toEqual({ unrestored: [join(target, ".git")] });
});
