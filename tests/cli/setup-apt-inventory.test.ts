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
    const inventoryMarker = join(directory, "inventory-presented.json");
    const inventoryArguments = join(directory, "inventory-arguments");
    const packages = { "docker-ce": "1", "docker-ce-cli": "1", "containerd.io": "2", "docker-buildx-plugin": "1", "docker-compose-plugin": "1" };
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const executable = async (name: string, body: string) => writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    const payload = async (name: string, text: string) => { const file = join(directory, name); await writeFile(file, text); return quote(file); };
    const inventory = Array.from({ length: rows }, (_, i) => `ordinary-package-${i}\t1\tinstalled\tok`).join("\n") + "\n";
    const inventoryFile = await payload("inventory.txt", inventory);
    const presented = { rows, bytes: Buffer.byteLength(inventory) };
    // These fixed OS responders avoid an unrelated Bun startup for every query.
    // The actual production subprocess collector and its stream limits still run.
    await executable("dpkg-query", `[ "$#" -eq 4 ] || exit 1\nprintf '%s\\n' "$@" > ${quote(inventoryArguments)}\nprintf '%s' ${quote(JSON.stringify(presented))} > ${quote(inventoryMarker)}\nexec /bin/cat ${inventoryFile}`);
    await executable("stat", `for last do :; done\ncase "$last" in *.asc|*.sources) printf 'regular file|0|644|1\\n';; *) printf 'directory|0|755|2\\n';; esac`);
    const source = "Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n";
    const keyFile = await payload("repository-key.asc", dockerRepositoryKey);
    const sourceFile = await payload("repository.sources", source);
    await executable("cat", `for last do :; done\ncase "$last" in *.asc) exec /bin/cat ${keyFile};; *) exec /bin/cat ${sourceFile};; esac`);
    const cacheFile = await payload("cache.txt", Object.entries(packages).map(([name, version]) => `Package: ${name}\nVersion: ${version}\n`).join("\n"));
    await executable("apt-cache", `exec /bin/cat ${cacheFile}`);
    const simulationFile = await payload("simulation.txt", Object.entries(packages).map(([name, version]) => `Inst ${name} (${version} Docker:stable [amd64])`).join("\n"));
    await executable("apt-get", `for arg do\n if [ "$arg" = '--print-uris' ]; then printf 'seen' > ${quote(marker)}; printf 'unavailable frozen URI\\n'; exit 0; fi\ndone\nexec /bin/cat ${simulationFile}`);
    const profile = { method: "docker-official-apt", verified: true, distribution: "ubuntu", release: "24.04", architecture: "x64", repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages, artifacts: aptFixtureArtifacts(packages) };
    const driver = join(directory, "driver.ts");
    await writeFile(driver, `import { productionHost } from ${JSON.stringify(resolve(import.meta.dir, "../../src/setup/host.ts"))};
import { setupCommands } from ${JSON.stringify(resolve(import.meta.dir, "../../src/setup/commands.ts"))};
import { runCli } from ${JSON.stringify(resolve(import.meta.dir, "../../src/cli/main.ts"))};
const host={...productionHost(),stateDirectory:${JSON.stringify(join(directory, "state"))},interactive:true,confirmHuman:async()=>"once" as const,host:async()=>({system:"linux",architecture:"x64",translated:false,release:"24.04",distribution:"ubuntu",machineId:"a".repeat(64)})};
const outcome=await runCli(["setup"],{cwd:${JSON.stringify(directory)},handlers:setupCommands(host,[${JSON.stringify(profile)} as const])});
process.stdout.write(JSON.stringify({outcome,uriReached:await Bun.file(${JSON.stringify(marker)}).exists()}));\n`);
    // The CLI retains its default60s operation deadline. The owner outlives it,
    // and the70s test cap permits joining a65s child before removing its files.
    const child = Bun.spawn([process.execPath, driver], { cwd: directory, env: { PATH: bin, HOME: directory }, stdout: "pipe", stderr: "pipe", timeout: 65000, killSignal: "SIGKILL" });
    const readers = [child.stdout.getReader(), child.stderr.getReader()];
    const outputs = readers.map(async (reader) => {
      const parts: Uint8Array[] = [];
      while (true) { const next = await reader.read(); if (next.done) return Buffer.concat(parts).toString("utf8"); parts.push(next.value); }
    });
    try {
      const [stdout, stderr, exit] = await Promise.all([outputs[0]!, outputs[1]!, child.exited]);
      expect(exit, stderr).toBe(0);
      const observed = JSON.parse(stdout) as { outcome: { exitCode: number; result: { error: { code: string; message: string } | null } }; uriReached: boolean };
      // Written before stdout: proves the intended producer/size, not that a
      // bounded reader consumed every byte before terminating the producer.
      expect(await Bun.file(inventoryMarker).json()).toEqual(presented);
      expect((await Bun.file(inventoryArguments).text()).trimEnd().split("\n")).toEqual(["--root=/", "--admindir=/var/lib/dpkg", "--show", "--showformat=${binary:Package}\t${Version}\t${db:Status-Status}\t${db:Status-Eflag}\\n"]);
      return { ...observed, inventoryBytes: presented.bytes };
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all(readers.map((reader) => reader.cancel().catch(() => {})));
      await Promise.allSettled(outputs);
      for (const reader of readers) reader.releaseLock();
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("the actual setup runner admits a healthy full package inventory larger than its normal output allowance", async () => {
  const observed = await realCollectorInventory(5000);
  expect(observed.uriReached).toBe(true);
  expect(observed.outcome.exitCode).toBe(4); // The fixture deliberately stops at URI resolution, before any download.
  expect(observed.inventoryBytes).toBeGreaterThan(65536);
  expect(observed.inventoryBytes).toBeLessThanOrEqual(2097152);
}, 70000);
test("the actual setup runner rejects inventory exceeding its bounded two-megabyte allowance", async () => {
  const observed = await realCollectorInventory(70000);
  expect(observed.uriReached).toBe(false);
  expect(observed.outcome.exitCode).toBe(5);
  expect(observed.inventoryBytes).toBeGreaterThan(2097152);
  expect(observed.outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
  expect(observed.outcome.result.error?.message).toContain("The complete host package state is unavailable or contains pending/error work");
}, 70000);
