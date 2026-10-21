import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dockerRepositoryKey } from "../../src/setup/docker-key.ts";
import { aptFixtureArtifacts } from "./fixtures/apt-artifacts.ts";

async function realCollectorInventory(rows: number) {
  const directory = await mkdtemp("/tmp/fleur-apt-inventory-");
  try {
    const bin = join(directory, "bin"); await mkdir(bin);
    const marker = join(directory, "uri-reached");
    const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
    const executable = async (name: string, body: string) => writeFile(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
    await executable("dpkg-query", `const args = process.argv.slice(2); if (args.length === 4) process.stdout.write(Array.from({length:${rows}}, (_, i) => 'ordinary-package-' + i + '\\t1\\tinstalled\\tok').join('\\n') + '\\n'); else process.exitCode=1;`);
    await executable("stat", `process.stdout.write(process.argv.at(-1).endsWith('.asc') || process.argv.at(-1).endsWith('.sources') ? 'regular file|0|644|1\\n' : 'directory|0|755|2\\n');`);
    const source = "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n";
    await executable("cat", `process.stdout.write(process.argv.at(-1).endsWith('.asc') ? ${JSON.stringify(dockerRepositoryKey)} : ${JSON.stringify(source)});`);
    await executable("apt-cache", `process.stdout.write(${JSON.stringify(Object.entries(packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"))});`);
    await executable("apt-get", `if (process.argv.includes('--print-uris')) { await Bun.write(${JSON.stringify(marker)}, 'seen'); process.stdout.write('unavailable frozen URI\\n'); } else process.stdout.write(${JSON.stringify(Object.entries(packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n"))});`);
    const profile = { method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };
    const driver = join(directory, "driver.ts");
    await writeFile(driver, `import { productionHost } from ${JSON.stringify(resolve(import.meta.dir, "../../src/setup/host.ts"))};
import { setupCommands } from ${JSON.stringify(resolve(import.meta.dir, "../../src/setup/commands.ts"))};
import { runCli } from ${JSON.stringify(resolve(import.meta.dir, "../../src/cli/main.ts"))};
const host={...productionHost(),stateDirectory:${JSON.stringify(join(directory, "state"))},interactive:true,confirmHuman:async()=>"once" as const,host:async()=>({system:"linux",architecture:"x64",translated:false,release:"24.04",distribution:"ubuntu",machineId:"a".repeat(64)})};
const outcome=await runCli(["setup"],{cwd:${JSON.stringify(directory)},handlers:setupCommands(host,[${JSON.stringify(profile)} as const])});
process.stdout.write(JSON.stringify({outcome,uriReached:await Bun.file(${JSON.stringify(marker)}).exists()}));\n`);
    const child = Bun.spawn([process.execPath, driver], { cwd: directory, env: { PATH: bin, HOME: directory }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    return JSON.parse(stdout) as { outcome: { exitCode: number }; uriReached: boolean };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("the actual setup runner admits a healthy full package inventory larger than its normal output allowance", async () => {
  const observed = await realCollectorInventory(5000);
  expect(observed.uriReached).toBe(true);
  expect(observed.outcome.exitCode).toBe(4); // The fixture deliberately stops at URI resolution, before any download.
});
test("the actual setup runner rejects inventory exceeding its bounded two-megabyte allowance", async () => {
  const observed = await realCollectorInventory(70000);
  expect(observed.uriReached).toBe(false);
  expect(observed.outcome.exitCode).toBe(5);
});
