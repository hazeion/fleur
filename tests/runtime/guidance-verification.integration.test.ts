import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { verifyArtifact } from "../../src/runtime/production/artifact";
const repository = resolve(import.meta.dir, "../..");
test("packed verification checks a public-API application and produces a verified production artifact", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleur-packed-verify-")));
  async function shell(args: string[], cwd = root) {
    const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  }
  try {
    const archive = join(root, "release.tgz");
    const packed = await shell([process.execPath, "pm", "pack", "--filename", archive], repository);
    expect(packed.exit, packed.stderr).toBe(0);
    const tar = join(root, "release.tar"); await writeFile(tar, Bun.gunzipSync(await readFile(archive)));
    expect((await shell(["/usr/bin/tar", "-xf", tar, "-C", root])).exit).toBe(0);
    const executable = join(root, "package/bin/fleur.ts"), app = join(root, "app");
    const created = await shell([process.execPath, executable, "new", app, "--no-git", "--json"]);
    expect(created.exit, created.stdout + created.stderr).toBe(0);
    for (const args of [["install", "--frozen-lockfile", "--ignore-scripts"], ["install", "--cwd", "lint", "--frozen-lockfile", "--ignore-scripts"]]) {
      const installed = await shell([process.execPath, ...args], app);
      expect(installed.exit, installed.stderr).toBe(0);
    }
    const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    const installedFleur = await shell([process.execPath, "add", "--ignore-scripts", "--no-save", archive], app);
    expect(installedFleur.exit, installedFleur.stderr).toBe(0);
    manifest.devDependencies.fleur = "0.1.0";
    await writeFile(join(app, "package.json"), JSON.stringify(manifest));
    await writeFile(join(app, "shared/page.ts"), 'import { definePage } from "fleur/routing";\nimport { schema } from "fleur/schema";\nexport const page = definePage({ path: "/", params: schema.object({}) });\n');
    await writeFile(join(app, "server/page.tsx"), 'import { registerPage } from "fleur/server";\nimport { page } from "../shared/page";\nregisterPage(page, { component: () => <main><h1>Verified public application</h1></main> });\n');
    await writeFile(join(app, "tests/value.test.ts"), 'import { expect, test } from "bun:test";\nimport { schema } from "fleur/schema";\ntest("rejects invalid public input", () => { expect(() => schema.string().parse(7)).toThrow(); });\n');
    const cli = join(app, "node_modules/fleur/bin/fleur.ts");
    await mkdir(join(app, "tests/unit"));
    await writeFile(join(app, "tests/unit/selected.test.ts"), 'import { expect, test } from "bun:test";\nimport { schema } from "fleur/schema";\ntest("selected input rejects", () => { expect(() => schema.localDate().parse("2026-02-30")).toThrow(); });\n');
    for (const args of [["explain"], ["test"], ["test", "--suite", "unit"], ["test", "--filter", "selected"], ["test", "--filter", "selected input"], ["types"], ["lint"]]) {
      const checked = await shell([process.execPath, cli, ...args, "--json"], app);
      expect(checked.exit, checked.stdout + checked.stderr).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({ formatVersion: 1, command: args[0], ok: true, error: null, truncated: false });
    }
    await mkdir(join(app, "tests/browser"));
    await writeFile(join(app, "tests/browser/interaction.test.ts"), 'import { expect, test } from "bun:test";\nimport { chromium } from "@playwright/test";\ntest("browser tool drives a real interaction", async () => { const browser = await chromium.launch({ headless: true, timeout: 10000 }); try { const page = await browser.newPage(); await page.setContent(\'<button onclick="this.textContent=String(Number(this.textContent)+1)">0</button>\'); await page.getByRole("button").click(); expect(await page.getByRole("button").textContent()).toBe("1"); } finally { await browser.close(); } }, 15000);\n');
    const browserSuite = await shell([process.execPath, cli, "test", "--suite", "browser", "--json"], app);
    expect(browserSuite.exit, browserSuite.stdout + browserSuite.stderr).toBe(0);
    expect(JSON.parse(browserSuite.stdout)).toMatchObject({ command: "test", ok: true });
    // An unselected failing file proves that the default runs the whole suite.
    await writeFile(join(app, "tests/failing.test.ts"), 'import { expect, test } from "bun:test";\ntest("intentional rejection", () => { expect(false).toBe(true); });\n');
    const failed = await shell([process.execPath, cli, "test", "--json"], app);
    expect(failed.exit).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ command: "test", ok: false, data: { failed: "tests" } });
    const subset = await shell([process.execPath, cli, "test", "--suite", "unit", "--json"], app);
    expect(subset.exit, subset.stdout).toBe(0);
    await rm(join(app, "tests/failing.test.ts"));
    const result = await shell([process.execPath, join(app, "node_modules/fleur/bin/fleur.ts"), "verify", "--timeout", "240", "--json"], app);
    if (result.exit !== 0) { const diagnostic = await shell([process.execPath, "run", "types"], app); console.info("[packed-verify-type-diagnostic]", diagnostic.stdout + diagnostic.stderr); }
    expect(result.exit, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.checks).toEqual(["tests", "types", "oxlint", "eslint", "build"]);
    const output = join(app, ".fleur/artifacts");
    const { readdir } = await import("node:fs/promises");
    const artifacts = (await readdir(output)).filter(name => !name.startsWith("."));
    expect(artifacts.length).toBeGreaterThan(0);
    const artifact = await verifyArtifact(join(output, artifacts[0]!), "0.1.0");
    expect(artifact.manifest.fleurVersion).toBe("0.1.0");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 360_000);
