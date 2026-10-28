import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir, symlink, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { projectCommands } from "../../src/project/commands.ts";
import { regenerateGuidance } from "../../src/project/guidance.ts";
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
test("runtime state is ignored without modifying an existing user gitignore", async () => {
  const cwd = await root();
  await writeFile(join(cwd, ".gitignore"), "user-data/\n");
  const outcome = await runCli(["init"], { cwd, handlers: projectCommands });
  expect(outcome.exitCode).toBe(0);
  expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe("user-data/\n");
  await writeFile(join(cwd, ".fleur", "runtime-secret"), "test fixture\n");
  const ignored = Bun.spawnSync(["git", "check-ignore", ".fleur/runtime-secret", ".fleur/.gitignore"], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(ignored.exitCode).toBe(0);
  expect(new TextDecoder().decode(ignored.stdout).trim().split("\n")).toEqual([".fleur/runtime-secret", ".fleur/.gitignore"]);
});
test("concurrent user edits to created files and guidance survive failed creation", async () => {
  const cwd = await root(); const commands = join(cwd, "commands"); await mkdir(commands);
  await writeFile(join(commands, "git"), '#!/bin/sh\nprintf "User package edit\\n" > "$6/package.json"\nprintf "Concurrent instruction\\n" >> "$6/AGENTS.md"\nexit 1\n', { mode: 0o755 });
  const target = join(cwd, "project"); await mkdir(target);
  await writeFile(join(target, "AGENTS.md"), "Original instructions\n");
  const previous = process.env.PATH; process.env.PATH = commands; let outcome;
  try { outcome = await runCli(["init"], { cwd: target, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(await readFile(join(target, "package.json"), "utf8")).toBe("User package edit\n");
  const guidance = await readFile(join(target, "AGENTS.md"), "utf8");
  expect(guidance).toStartWith("Original instructions\n");
  expect(guidance).toEndWith("Concurrent instruction\n");
});
test("no-git creation observes its absolute timeout before writing", async () => {
  const cwd = await root();
  const outcome = await runCli(["new", "project", "--no-git", "--timeout", "0.000001"], { cwd, handlers: projectCommands });
  expect(outcome.exitCode).toBe(1);
  expect(await readdir(cwd)).toEqual([]);
});
test("a replaced project directory is left untouched and requires recovery", async () => {
  const cwd = await root(); const commands = join(cwd, "commands"); await mkdir(commands);
  await writeFile(join(commands, "git"), '#!/bin/sh\n/bin/mv "$6" "$6.saved"\n/bin/mkdir "$6"\nprintf "User replacement\\n" > "$6/package.json"\nexit 1\n', { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = commands; let outcome;
  try { outcome = await runCli(["new", "project"], { cwd, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(await readdir(join(cwd, "project"))).toEqual(["package.json"]);
  expect(await readFile(join(cwd, "project", "package.json"), "utf8")).toBe("User replacement\n");
  expect(await Bun.file(join(cwd, "project.saved", "fleur.json")).exists()).toBe(true);
});

test("replacement of an existing guidance parent is detected without removing the moved user tree", async () => {
  const cwd = await root(); const commands = join(cwd, "commands"); await mkdir(commands);
  const target = join(cwd, "project"); await mkdir(join(target, ".agents", "skills"), { recursive: true });
  await writeFile(join(target, ".agents", "user-notes"), "Preserve user notes\n");
  await writeFile(join(commands, "git"), '#!/bin/sh\n/bin/mv "$6/.agents" "$6/../moved-agents"\n/bin/ln -s "$6/../moved-agents" "$6/.agents"\nexit 0\n', { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = commands; let outcome;
  try { outcome = await runCli(["init"], { cwd: target, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect((await lstat(join(target, ".agents"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(cwd, "moved-agents", "user-notes"), "utf8")).toBe("Preserve user notes\n");
  expect(await Bun.file(join(cwd, "moved-agents", "skills", "fleur-tdd", "SKILL.md")).exists()).toBe(true);
});
test("non-directory planned parents produce a zero-write collision result", async () => {
  for (const parent of [".agents", ".agents/skills", ".fleur"]) {
    const cwd = await root();
    if (parent.includes("/")) await mkdir(join(cwd, ".agents"));
    await writeFile(join(cwd, parent), "Preserve this file\n");
    const before = await readdir(cwd);
    const outcome = await runCli(["init", "--no-git"], { cwd, handlers: projectCommands });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result.error?.code).toBe("PROJECT_COLLISION");
    expect(await readdir(cwd)).toEqual(before);
    expect(await readFile(join(cwd, parent), "utf8")).toBe("Preserve this file\n");
  }
});
test("a changed project pin cannot be reported as successful creation", async () => {
  const cwd = await root(); const commands = join(cwd, "commands"); await mkdir(commands);
  await writeFile(join(commands, "git"), '#!/bin/sh\nprintf \'{"fleurVersion":"9.9.9"}\\n\' > "$6/fleur.json"\nexit 0\n', { mode: 0o755 });
  const target = join(cwd, "project"); await mkdir(target);
  const previous = process.env.PATH; process.env.PATH = commands; let outcome;
  try { outcome = await runCli(["init"], { cwd: target, handlers: projectCommands }); }
  finally { process.env.PATH = previous; }
  expect(outcome.exitCode).toBe(5);
  expect(outcome.result.ok).toBe(false);
  expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(JSON.parse(await readFile(join(target, "fleur.json"), "utf8"))).toEqual({ fleurVersion: "9.9.9" });
});
test("ordinary no-git deadline expiry completely removes only its own partial scaffold", async () => {
  for (const timeout of ["0.000001", "0.001", "0.003", "0.005", "0.01", "0.015", "0.02", "0.025", "0.03", "0.04"]) {
    const cwd = await root();
    const outcome = await runCli(["new", "project", "--no-git", "--timeout", timeout], { cwd, handlers: projectCommands });
    if (!outcome.result.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(outcome.result.error?.code).toBe("PROJECT_CREATION_FAILED");
      expect(await readdir(cwd)).toEqual([]);
    }
  }
});
test("deadline rollback preserves original guidance through each observed creation stage", async () => {
  for (const timeout of ["0.000001", "0.005", "0.01", "0.015", "0.02", "0.025", "0.03", "0.04", "0.05", "0.06"]) {
    const cwd = await root();
    await writeFile(join(cwd, "AGENTS.md"), "Original agent instructions\n");
    await writeFile(join(cwd, "CLAUDE.md"), "Original Claude instructions\n");
    const outcome = await runCli(["init", "--no-git", "--timeout", timeout], { cwd, handlers: projectCommands });
    if (!outcome.result.ok) {
      expect(outcome.exitCode).toBe(1);
      expect(await readdir(cwd)).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe("Original agent instructions\n");
      expect(await readFile(join(cwd, "CLAUDE.md"), "utf8")).toBe("Original Claude instructions\n");
    }
  }
});
test("creation supplies strict TypeScript and independent pinned lint tooling without fake application build commands", async () => {
  const cwd = await root();
  expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
  const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  expect(manifest.scripts.types).toBe("bun ./node_modules/typescript/bin/tsc --noEmit");
  expect(manifest.scripts.lint).toContain("./lint/node_modules/eslint/bin/eslint.js");
  expect(manifest.scripts.build).toBeUndefined();
  const config = JSON.parse(await readFile(join(cwd, "tsconfig.json"), "utf8"));
  expect(config.compilerOptions).toMatchObject({ strict: true, noEmit: true, jsx: "react-jsx", jsxImportSource: "preact" });
  expect(await readFile(join(cwd, "shared", "placeholder.ts"), "utf8")).toContain("export {}");
  expect(JSON.parse(await readFile(join(cwd, "lint", "package.json"), "utf8")).dependencies).toEqual({ eslint: "10.12.0", "typescript-eslint": "8.71.2", typescript: "6.0.3" });
  expect(await Bun.file(join(cwd, "lint", "bun.lock")).exists()).toBe(true);
});
test("generated pin and guidance use the packed release metadata as their one version authority", async () => {
  const cwd = await root(); const archive = join(cwd, "release.tgz");
  const packed = Bun.spawn([process.execPath, "pm", "pack", "--filename", archive], { cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe" });
  const [packExit] = await Promise.all([packed.exited, new Response(packed.stdout).text(), new Response(packed.stderr).text()]);
  expect(packExit).toBe(0);
  const extracted = Bun.spawnSync(["/usr/bin/tar", "-xzf", archive, "-C", cwd], { stdout: "pipe", stderr: "pipe" });
  expect(extracted.exitCode).toBe(0);
  const metadataPath = join(cwd, "package", "package.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")); metadata.version = "0.2.0";
  await writeFile(metadataPath, JSON.stringify(metadata));
  const invocation = 'import {runCli} from "./package/src/cli/main.ts"; import {projectCommands} from "./package/src/project/commands.ts"; const value=await runCli(["new","app","--no-git"],{cwd:process.cwd(),handlers:projectCommands}); console.log(JSON.stringify(value));';
  const child = Bun.spawn([process.execPath, "-e", invocation], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0); expect(stderr).toBe(""); expect(JSON.parse(stdout).exitCode).toBe(0);
  expect(JSON.parse(await readFile(join(cwd, "app", "fleur.json"), "utf8")).fleurVersion).toBe("0.2.0");
  expect(JSON.parse(await readFile(join(cwd, "app", "package.json"), "utf8")).fleur.version).toBe("0.2.0");
  expect(await readFile(join(cwd, "app", "AGENTS.md"), "utf8")).toContain("fleur:generated:start version=0.2.0");
  expect(await readFile(join(cwd, "app", "docs", "fleur.md"), "utf8")).toContain("Fleur 0.2.0");
  expect(await readFile(join(cwd, "app", ".agents", "skills", "fleur-tdd", "SKILL.md"), "utf8")).toContain("fleur-version: 0.2.0");
});
test("new rejects an empty directory argument while accepting explicit dot and Unicode names", async () => {
  const cwd = await root();
  const invalid = await runCli(["new", "", "--no-git"], { cwd, handlers: projectCommands });
  expect(invalid.exitCode).toBe(2); expect(invalid.result.error?.code).toBe("ARGUMENT_INVALID");
  expect(await readdir(cwd)).toEqual([]);
  const named = await runCli(["new", "日本語 project", "--no-git"], { cwd, handlers: projectCommands });
  expect(named.exitCode).toBe(0);
  const dot = await root(); expect((await runCli(["new", ".", "--no-git"], { cwd: dot, handlers: projectCommands })).exitCode).toBe(0);
});
test("both instruction files reference offline pinned guidance and the approved imports without inventing working APIs", async () => {
  const cwd = await root();
  expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const text = await readFile(join(cwd, name), "utf8");
    expect(text).toContain("docs/fleur.md");
    for (const allowed of ["fleur/schema", "fleur/database", "fleur/server", "fleur/client", "fleur/routing", "preact/hooks"]) expect(text).toContain(allowed);
  }
  const offline = await readFile(join(cwd, "docs", "fleur.md"), "utf8");
  expect(offline).toContain("Fleur 0.1.0");
  expect(offline).toContain("inferred read-page APIs and an internal restricted rendering adapter");
  expect(offline).toContain("docs/read-pages.md and dist/reference");
  expect(offline).toContain("No application is running after init");
  expect(offline).toContain("docs/mutations.md");
  expect(offline).toContain("Never automatically replay an unknown mutation");
  expect(offline).toContain("docs/reactivity.md");
  expect(offline).toContain("Use stable keys to preserve island drafts, focus and local state");
  expect(offline).toContain("Lifecycle commands, external retrieval and production operations require their later implementations");
  expect(offline).toContain("bun run types");
  expect(offline).toContain("TypeScript 6.0.3");
});
test("new protected tooling files collide before writes and existing unrelated docs remain intact", async () => {
  for (const name of ["tsconfig.json", ".oxlintrc.json", "lint", "docs/fleur.md"]) {
    const cwd = await root();
    if (name.includes("/")) await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, name), "Keep user configuration\n");
    const before = await readdir(cwd);
    const outcome = await runCli(["init", "--no-git"], { cwd, handlers: projectCommands });
    expect(outcome.exitCode).toBe(5); expect(outcome.result.error?.code).toBe("PROJECT_COLLISION");
    expect(await readdir(cwd)).toEqual(before);
    expect(await readFile(join(cwd, name), "utf8")).toBe("Keep user configuration\n");
  }
  const cwd = await root(); await mkdir(join(cwd, "docs")); await writeFile(join(cwd, "docs", "user.md"), "Keep user documentation\n");
  expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
  expect(await readFile(join(cwd, "docs", "user.md"), "utf8")).toBe("Keep user documentation\n");
});
test("generated compiler accepts ordinary explicit TypeScript and TSX module imports", async () => {
  const cwd = await root();
  expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
  await symlink(join(import.meta.dir, "../../node_modules"), join(cwd, "node_modules"));
  await writeFile(join(cwd, "shared", "local.ts"), "export const value = 1;\n");
  await writeFile(join(cwd, "client", "local.tsx"), 'export const label = "fixture";\n');
  await writeFile(join(cwd, "server", "consumer.ts"), 'import { value } from "../shared/local.ts";\nexport const result: number = value;\n');
  await writeFile(join(cwd, "client", "consumer.ts"), 'import { label } from "./local.tsx";\nexport const result: string = label;\n');
  const child = Bun.spawn([process.execPath, "run", "types"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stdout, stderr }).toMatchObject({ exit: 0 });
});
async function databaseSection(cwd: string) {
  const text = await readFile(join(cwd, "AGENTS.md"), "utf8");
  const start = text.indexOf("\n## Database\n");
  const end = text.indexOf("<!-- fleur:generated:end -->");
  expect(start).toBeGreaterThan(text.indexOf("<!-- fleur:generated:start"));
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}
async function releaseCommands(): Promise<string[]> {
  const cwd = await root();
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../bin/fleur.ts"), "help", "--json"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(0);
  return (JSON.parse(stdout).data.commands as { name: string }[]).map(({ name }) => name);
}
function namedCommands(text: string): string[] {
  return [...text.matchAll(/`(?:fleur )?((?:db|status|dev|setup|doctor|new|init)(?: [a-z][a-z-]*)*)(?=[ `])/g)].map((match) => match[1]!);
}
test("generated AGENTS.md has a dedicated database section covering every specified topic and CLAUDE.md references it", async () => {
  const cwd = await root();
  expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
  const section = (await databaseSection(cwd)).toLowerCase();
  const topics: Record<string, string[]> = {
    "tables, relations, versioning and typed data access": ["definetable", "definerelations", "versioned", "definequery", "definemutation", "only data access path"],
    "raw SQL and ORM imports unavailable, suggesting capabilities": ["raw sql", "drizzle", "bun sql", "suggest", "existing alternatives"],
    "migration workflow and immutability": ["fleur db migration generate", "fleur db migration plan", "fleur db migration apply", "fleur db migration status", "never edit or remove an applied migration"],
    "declarative seeds and approved reset": ["defineseed", "fleur db seed", "fleur db reset", "approval"],
    "inferred types and runtime validation": ["inferred types", "runtime validation at every boundary"],
    "credentials, disposable test data and destructive authority": ["credential", "disposable", "development data", "destructive"],
    "checks after a schema change": ["bun run types", "disposable postgresql", "drift", "pending", "restart"],
  };
  for (const [topic, phrases] of Object.entries(topics)) for (const phrase of phrases) expect({ topic, present: section.includes(phrase) }).toEqual({ topic, present: true });
  expect(section).toMatch(/`db query` is a development-only diagnostic[^.]*never a data access path for application code/);
  const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
  expect(claude).toContain("Database section of AGENTS.md");
  expect(claude).not.toContain("\n## Database\n");
});
test("the database section names only operations in the pinned release and marks later ones unavailable", async () => {
  const cwd = await root();
  expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
  const section = await databaseSection(cwd);
  const split = section.indexOf("\n### Not available in this release\n");
  expect(split).toBeGreaterThan(0);
  const available = section.slice(0, split), unavailable = section.slice(split);
  const released = await releaseCommands();
  const resolves = (command: string) => released.some((name) => command === name || command.startsWith(name + " "));
  const named = namedCommands(available);
  expect(named.length).toBeGreaterThan(0);
  for (const command of named) expect({ command, released: resolves(command) }).toEqual({ command, released: true });
  for (const command of released.filter((name) => name.startsWith("db "))) expect({ command, named: named.some((item) => item === command || item.startsWith(command + " ")) }).toEqual({ command, named: true });
  for (const later of ["db query", "status", "dev"]) {
    expect(resolves(later)).toBe(false);
    expect(named).not.toContain(later);
    expect(namedCommands(unavailable)).toContain(later);
  }
  for (const capability of ["schema overview", "database health", "`db query`"]) expect(unavailable).toContain(capability);
});
test("regenerating guidance replaces only the marked generated section and preserves user content around it", async () => {
  for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
    const cwd = await root();
    await writeFile(join(cwd, name), "User preface\n");
    expect((await runCli(["init", "--no-git"], { cwd, handlers: projectCommands })).exitCode).toBe(0);
    const current = (await readFile(join(cwd, name), "utf8")).slice("User preface\n".length);
    const stale = "User preface\n<!-- fleur:generated:start version=0.0.9 -->\n# Old guidance\nOld database rules\n<!-- fleur:generated:end -->\nUser notes after the section\n";
    expect(regenerateGuidance(name, stale)).toBe(`User preface\n${current}User notes after the section\n`);
    expect(regenerateGuidance(name, `User preface\n${current}`)).toBe(`User preface\n${current}`);
    for (const malformed of ["User only\n", `${current}${current}`, "<!-- fleur:generated:end -->\n<!-- fleur:generated:start version=0.1.0 -->\n", "<!-- fleur:generated:start version=0.1.0 -->\nunterminated\n"]) expect(() => regenerateGuidance(name, malformed)).toThrow();
  }
});
