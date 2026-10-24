import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import { debianDependencyProfile } from "./fixtures/apt-debian-dependencies.ts";

async function plan(options: { conflictingPath?: string; service?: string; unitLinks?: string; profile?: typeof debianDependencyProfile; packageQuery?: { stdout: string; exitCode: number; terminationUnconfirmed?: boolean } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleur-debian-dependency-plan-"));
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: directory, handlers: setupCommands({
      stateDirectory: join(directory, "state"),
      host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "13", distribution: "debian", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "docker") return { status: "missing", stdout: "", stderr: "" };
        if (args[0] === "dpkg-query") return { status: "completed", exitCode: 1, stdout: "", stderr: "", ...options.packageQuery };
        if (args[0] === "stat") return args.at(-1) === options.conflictingPath
          ? { status: "completed", exitCode: 0, stdout: "regular file|0|644|1\n", stderr: "" }
          : { status: "completed", exitCode: 1, stdout: "", stderr: "No such file or directory" };
        if (args[0] === "find") return { status: "completed", exitCode: 0, stdout: options.unitLinks ?? "", stderr: "" };
        if (args[0] === "systemctl") return { status: "completed", exitCode: 0, stdout: options.service ?? "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nFragmentPath=\nDropInPaths=\nTransient=no\n", stderr: "" };
        throw new Error("JSON planning authorizes observations only");
      },
    }, [options.profile ?? debianDependencyProfile]) });
    return { outcome, calls, grantsCreated: await Bun.file(join(directory, "state/grants.json")).exists() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Debian setup discloses every pinned missing dependency and its effects before authority", async () => {
    const { outcome, calls, grantsCreated } = await plan();
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ packageState: { missing: ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4", "libnftables1", "nftables"] } });
    const data = outcome.result.data as { plan: { target: string; checksum: string } };
    for (const text of ["nftables=1.1.3-1", "libnftables1=1.1.3-1", "libjansson4=2.14-2+b3", "configuration", "helper state", "systemd", "ldconfig"]) expect(data.plan.target).toContain(text);
    expect(calls.some((args) => ["curl", "apt-get", "sudo"].includes(args[0]!))).toBe(false);
    expect(grantsCreated).toBe(false);
});

test("missing nftables with an existing configuration refuses before authority", async () => {
  const { outcome, calls, grantsCreated } = await plan({ conflictingPath: "/etc/nftables.conf" });
  expect(outcome.exitCode).toBe(4);
  expect(outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
  expect(outcome.result.error?.message).toContain("nftables");
  expect(grantsCreated).toBe(false);
  expect(calls.some((args) => ["curl", "apt-get", "sudo"].includes(args[0]!))).toBe(false);
});

for (const unitLinks of ["/etc/systemd/system/nftables.service\n", "/run/systemd/system/nftables.service.d\n", "/etc/systemd/system/multi-user.target.wants/nftables.service\n", "/var/lib/systemd/deb-systemd-helper-enabled/nftables.service.dsh-also\n", "/var/lib/systemd/deb-systemd-helper-masked/nftables.service\n"]) {
  test(`missing nftables preserves existing unit or helper evidence: ${unitLinks.trim()}`, async () => {
    const { outcome, grantsCreated } = await plan({ unitLinks });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(grantsCreated).toBe(false);
  });
}
for (const service of ["LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nFragmentPath=\nDropInPaths=\nTransient=no\n", "LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=\nFragmentPath=\nDropInPaths=\nTransient=yes\n", "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nFragmentPath=\nDropInPaths=/run/systemd/system/foreign.conf\nTransient=no\n", "LoadState=not-found\n", ""]) {
  test(`missing nftables refuses loaded, transient or incomplete service observations: ${JSON.stringify(service)}`, async () => {
    const { outcome, grantsCreated } = await plan({ service });
    expect(outcome.exitCode).toBe(4);
    expect(grantsCreated).toBe(false);
  });
}

test("a declared nftables dependency closure must satisfy its exact libnftables version", async () => {
  const profile = structuredClone(debianDependencyProfile);
  profile.distroDependencies.artifacts.libnftables1.version = "1.1.3-99";
  profile.distroDependencies.artifacts.libnftables1.url = "https://deb.debian.org/debian/pool/main/n/nftables/libnftables1_1.1.3-99_amd64.deb";
  const { outcome, grantsCreated } = await plan({ profile });
  expect(outcome.exitCode).toBe(4);
  expect(grantsCreated).toBe(false);
});

test("the complete declared Debian dependency closure reaches the guarded exact local installation", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario();
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed", packages: ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4", "libnftables1", "nftables"] } });
  expect(result.downloads).toBe(3);
  expect(result.initialPlans).toBe(1);
  expect(result.privilegedPlans).toBe(1);
  expect(result.installs).toBe(1);
  expect(result.configured).toHaveLength(8);
  expect(result.entries.some((name) => name.startsWith("apt-payloads-") || name === "apt-transaction-pending.json")).toBe(false);
});

for (const option of ["consentDrift", "acquisitionDrift", "installDrift"] as const) {
  test(`nftables state drift refuses privileged installation: ${option}`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ [option]: true });
    expect(result.outcome.exitCode).toBe(5);
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
    if (option === "consentDrift") expect(result.downloads).toBe(0);
    if (option === "installDrift") expect(result.entries).toContain("apt-transaction-pending.json");
  });
}
for (const phase of ["initial", "privileged"] as const) {
  test(`the ${phase} exact simulation refuses an undeclared transitive dependency`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ extraSimulation: phase });
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
    expect(result.entries.some((name) => name.startsWith("apt-payloads-") || name === "apt-transaction-pending.json")).toBe(false);
  });
}
for (const fault of ["missing", "hash", "oversize", "uncertain"] as const) {
  test(`dependency acquisition ${fault} cannot authorize installation or lose uncertain custody`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ downloadFault: fault });
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
    expect(result.outcome.exitCode).toBe(fault === "uncertain" || fault === "oversize" ? 5 : 4);
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(fault === "uncertain" || fault === "oversize");
  });
}

test("matching configured Debian dependencies are reused without downloads or reinstalls", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ present: ["libjansson4", "libnftables1", "nftables"] });
  expect(result.outcome.result.data).toMatchObject({ setupAction: { state: "completed", packages: ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin"] } });
  expect(result.downloads).toBe(0);
  expect(result.installs).toBe(1);
  const privileged = result.calls.find((args) => args[0] === "sudo" && args.includes("install") && !args.includes("--simulate"))!;
  expect(privileged.slice(privileged.indexOf("install") + 1)).toHaveLength(5);
});
test("native-qualified Multi-Arch dependency identities survive install, reuse and reboot reconciliation", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const installed = await debianScenario({ dependencyNames: "native" });
  expect(installed.outcome.result.data).toMatchObject({ setupAction: { state: "completed" } });
  expect(installed.installs).toBe(1);
  const reused = await debianScenario({ dependencyNames: "native", present: ["libjansson4", "libnftables1", "nftables"] });
  expect(reused.outcome.result.data).toMatchObject({ setupAction: { state: "completed" } });
  expect(reused.downloads).toBe(0);
  const recovered = await debianScenario({ dependencyNames: "native", interrupted: true });
  expect(recovered.resumed?.result.data).toMatchObject({ recovery: { state: "reconciled", historicalOutcome: "unknown", artifacts: "retained" } });
  expect(recovered.installs).toBe(1);
});
for (const dependencyNames of ["foreign", "duplicate"] as const) test(`dependency inventory refuses ${dependencyNames} architecture identities before consent`, async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ dependencyNames, present: ["libjansson4", "libnftables1", "nftables"] });
  expect(result.outcome.exitCode).toBe(4);
  expect(result.prompts).toEqual([]);
  expect(result.installs).toBe(0);
});
test("native-qualified dependency simulation and real hook actions retain the exact declared closure", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ simulationNames: "native", guardFault: "native-dependency-architecture" });
  expect(result.outcome.result.data).toMatchObject({ setupAction: { state: "completed" } });
  expect(result.installs).toBe(1);
});
for (const simulationNames of ["foreign", "duplicate"] as const) test(`simulation refuses ${simulationNames} dependency architecture identities`, async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ simulationNames });
  expect(result.outcome.exitCode).toBe(4);
  expect(result.installs).toBe(0);
});
for (const guardFault of ["foreign-dependency-architecture", "duplicate-dependency-alias"] as const) test(`the real eight-package hook refuses ${guardFault}`, async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ guardFault });
  expect(result.outcome.exitCode).not.toBe(0);
  expect(result.installs).toBe(0);
  expect(result.calls.some((args) => args[0] === "sudo" && args.includes("install") && !args.includes("--simulate"))).toBe(true);
  expect(result.configured).toEqual(result.baseline);
});
for (const recoveryHealthNames of ["foreign", "duplicate"] as const) test(`reboot reconciliation preserves custody when full-health dependency identities become ${recoveryHealthNames}`, async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ interrupted: true, recoveryHealthNames });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.installs).toBe(1);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-reconciled-"))).toBe(false);
  expect(result.afterRecovery).toEqual(result.beforeRecovery);
});
test("configured dependency conflicts refuse before consent instead of upgrading", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ present: ["libjansson4"], conflictingVersion: "2.13-1" });
  expect(result.outcome.exitCode).toBe(4);
  expect(result.prompts).toEqual([]);
  expect(result.downloads).toBe(0);
  expect(result.installs).toBe(0);
  expect(result.configured).toEqual(result.baseline);
});

test("expanded interrupted setup retains every declared dependency through read-only reboot reconciliation", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ interrupted: true });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.doctor?.exitCode).toBe(5);
  expect(result.sameBoot?.exitCode).toBe(5);
  expect(result.resumed?.result.data).toMatchObject({ recovery: { state: "reconciled", historicalOutcome: "unknown", artifacts: "retained" } });
  expect(result.installs).toBe(1);
  expect(result.beforeRecovery).toEqual(result.afterRecovery);
  expect(result.pending!.artifacts.entries.filter((entry: { path: string }) => /^(libjansson4|libnftables1|nftables)\/.+\.deb$/.test(entry.path))).toHaveLength(3);
  expect(result.entries).not.toContain("apt-transaction-pending.json");
});


test("declared dependency acquisition suppresses curl configuration before every other option", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario();
  const downloads = result.calls.filter((args) => args[0] === "curl");
  expect(downloads).toHaveLength(3);
  for (const args of downloads) {
    expect(args[1]).toBe("--disable");
    expect(args).toContain("--max-filesize");
    expect(args.slice(args.indexOf("--max-redirs"), args.indexOf("--max-redirs") + 2)).toEqual(["--max-redirs", "0"]);
  }
});
for (const controlFault of ["version", "architecture", "uncertain"] as const) {
  test(`dependency control ${controlFault} refuses installation and preserves uncertain reader custody`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ controlFault });
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
    expect(result.outcome.exitCode).toBe(controlFault === "uncertain" ? 5 : 4);
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(controlFault === "uncertain");
  });
}
for (const uncertainSimulation of ["initial", "privileged"] as const) {
  test(`unconfirmed ${uncertainSimulation} simulation retains archive custody`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ uncertainSimulation });
    expect(result.installs).toBe(0);
    expect(result.outcome.exitCode).toBe(5);
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
  });
}

for (const fault of ["unknown-field", "partial-closure", "foreign-package", "docker-signer", "unknown-signer", "http", "foreign-origin", "query", "encoded-path", "wrong-name", "wrong-architecture", "malformed-hash"] as const) {
  test(`a malformed Debian closure cannot produce an authorized plan: ${fault}`, async () => {
    const profile = structuredClone(debianDependencyProfile);
    const closure = profile.distroDependencies;
    if (fault === "unknown-field") Object.assign(closure, { allowExtraPackages: true });
    if (fault === "partial-closure") Reflect.deleteProperty(closure.artifacts, "libjansson4");
    if (fault === "foreign-package") Object.assign(closure.artifacts, { arbitrary: closure.artifacts.nftables });
    if (fault === "docker-signer") closure.repositoryFingerprint = profile.repositoryFingerprint;
    if (fault === "unknown-signer") closure.signingFingerprint = "A".repeat(40);
    if (fault === "http") closure.artifacts.nftables.url = closure.artifacts.nftables.url.replace("https:", "http:");
    if (fault === "foreign-origin") closure.artifacts.nftables.url = closure.artifacts.nftables.url.replace("deb.debian.org", "foreign.invalid");
    if (fault === "query") closure.artifacts.nftables.url += "?package=foreign";
    if (fault === "encoded-path") closure.artifacts.nftables.url = closure.artifacts.nftables.url.replace("/pool/", "/pool%2f");
    if (fault === "wrong-name") Object.assign(closure.artifacts.nftables, { name: "foreign" });
    if (fault === "wrong-architecture") Object.assign(closure.artifacts.nftables, { architecture: "arm64" });
    if (fault === "malformed-hash") closure.artifacts.nftables.sha256 = "unverified";
    const { outcome, calls, grantsCreated } = await plan({ profile });
    expect(outcome.exitCode).toBe(4);
    expect(grantsCreated).toBe(false);
    expect(calls.some((args) => ["curl", "apt-get", "sudo"].includes(args[0]!))).toBe(false);
  });
}
for (const configuredStatus of ["config-files", "unpacked", "half-configured", "triggers-pending"]) {
  test(`residual dependency status ${configuredStatus} requires manual recovery without configuration`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ present: ["nftables"], configuredStatus });
    expect(result.outcome.exitCode).toBe(4);
    expect(result.prompts).toEqual([]);
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
  });
}
for (const guardClosureFault of ["missing-marker", "wrong-signer", "declared-digest", "partial-closure", "mixed-architecture"] as const) {
  test(`the real eight-package hook refuses invalid closure data with a matching file digest: ${guardClosureFault}`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ guardClosureFault });
    expect(result.privilegedPlans).toBe(1);
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
  });
}
for (const guardFault of ["extra-configure", "unknown-package", "existing-version", "direction", "target-version", "configure-before-install", "duplicate-configure", "duplicate-install", "missing-install", "archive-path-canonical", "archive-path-different", "package-state", "archive-identity", "archive-digest"] as const) {
  test(`the real eight-package hook preserves the existing operation refusal: ${guardFault}`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ guardFault });
    expect(result.privilegedPlans).toBe(1);
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
  });
}

test("changed retained dependency bytes refuse reconciliation and retain the active fence", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ interrupted: true, recoveryTamper: true });
  expect(result.resumed?.exitCode).toBe(5);
  expect(result.entries).toContain("apt-transaction-pending.json");
  expect(result.entries.some((name) => name.startsWith("apt-reconciled-"))).toBe(false);
  expect(result.installs).toBe(1);
  expect(result.beforeRecovery?.grants).toBe(result.afterRecovery?.grants);
});


for (const downloadCollision of ["file", "symlink"] as const) {
  test(`dependency curl preserves a foreign ${downloadCollision} inserted before output open`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ downloadCollision });
    expect(result.foreignBytes).toBe("preserve foreign acquisition bytes");
    expect(result.installs).toBe(0);
    expect(result.outcome.exitCode).toBe(5);
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
  });
}
for (const rejectedObservation of ["control", "initial-simulation"] as const) {
  test(`rejected ${rejectedObservation} completion retains the fully tracked stage`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ rejectedObservation });
    expect(result.outcome.exitCode).toBe(5);
    expect(result.installs).toBe(0);
    expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
  });
}
test("rejected acquisition completion retains its owned stage without terminal proof", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ downloadFault: "rejected" });
  expect(result.outcome.exitCode).toBe(5);
  expect(result.installs).toBe(0);
  expect(result.entries.some((name) => name.startsWith("apt-payloads-"))).toBe(true);
});


test("dependency output is exclusively claimed and passed as an inherited descriptor", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario();
  expect(result.outputClaims).toHaveLength(3);
  for (const claim of result.outputClaims) {
    expect(claim.output).toBe("-");
    expect(claim.descriptor).toBeGreaterThanOrEqual(3);
  }
  expect(result.installs).toBe(1);
});

// Observed on the pinned fresh Debian 13 image: referenced but absent nftables
// has an explicit row, while the seven unknown package names are omitted.
test("Debian setup treats the real empty-version not-installed record as missing before authority", async () => {
  const { outcome, calls, grantsCreated } = await plan({ packageQuery: { stdout: "nftables\t\tnot-installed\tok\n", exitCode: 1 } });
  expect(outcome.exitCode).toBe(3);
  expect(outcome.result.error?.code).toBe("AUTHORITY_REQUIRED");
  expect(outcome.result.data).toMatchObject({ packageState: { state: "compatible", present: [], missing: ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4", "libnftables1", "nftables"] } });
  expect(grantsCreated).toBe(false);
  expect(calls.some((args) => ["curl", "apt-get", "sudo"].includes(args[0]!))).toBe(false);
});

test("the real Debian installation guard accepts genuine absent nftables state without relaxing its closure", async () => {
  const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
  const result = await debianScenario({ absentNftablesRecord: true });
  expect(result.outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" }, packageState: { state: "compatible", missing: [] } });
  expect(result.downloads).toBe(3);
  expect(result.initialPlans).toBe(1);
  expect(result.privilegedPlans).toBe(1);
  expect(result.installs).toBe(1);
  expect(result.configured).toHaveLength(8);
  expect(result.entries.some((name) => name.startsWith("apt-payloads-") || name === "apt-transaction-pending.json")).toBe(false);
});

for (const exitCode of [0, 1]) {
  test(`an unconfirmed package query with exit ${exitCode} cannot establish missing packages or request authority`, async () => {
    const names = ["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4", "libnftables1", "nftables"];
    const { outcome, calls, grantsCreated } = await plan({ packageQuery: { stdout: names.map((name) => `${name}\t\tnot-installed\tok\n`).join(""), exitCode, terminationUnconfirmed: true } });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ packageState: { state: "unavailable", present: [], missing: [] } });
    expect(grantsCreated).toBe(false);
    expect(calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
  });
}

test("a complete successful query counts explicit absent rows separately from installed packages", async () => {
  const stdout = "containerd.io\t2.4.2-2~debian.13~trixie\tinstalled\tok\n" + ["docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4:amd64", "libnftables1:amd64", "nftables"].map((name) => `${name}\t\tnot-installed\tok\n`).join("");
  const { outcome, grantsCreated } = await plan({ packageQuery: { stdout, exitCode: 0 } });
  expect(outcome.exitCode).toBe(3);
  expect(outcome.result.data).toMatchObject({ packageState: { state: "compatible", present: ["containerd.io"], missing: ["docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4", "libnftables1", "nftables"] } });
  expect(grantsCreated).toBe(false);
});

for (const [label, stdout] of [
  ["retained version", "nftables\t1.1.3-1\tnot-installed\tok\n"],
  ["retained configuration", "nftables\t\tconfig-files\tok\n"],
  ["error flag", "nftables\t\tnot-installed\treinstreq\n"],
  ["duplicate absent", "nftables\t\tnot-installed\tok\nnftables\t\tnot-installed\tok\n"],
  ["absent then installed", "nftables\t\tnot-installed\tok\nnftables\t1.1.3-1\tinstalled\tok\n"],
  ["duplicate dependency alias", "libnftables1\t\tnot-installed\tok\nlibnftables1:amd64\t\tnot-installed\tok\n"],
  ["foreign dependency", "libnftables1:arm64\t\tnot-installed\tok\n"],
  ["unknown package", "foreign-package\t\tnot-installed\tok\n"],
] as const) {
  test(`absent records do not bypass package planning refusal: ${label}`, async () => {
    const { outcome, calls, grantsCreated } = await plan({ packageQuery: { stdout, exitCode: 1 } });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ packageState: { state: "conflict", present: [], missing: [] } });
    expect(grantsCreated).toBe(false);
    expect(calls.map((args) => args[0])).toEqual(["docker", "dpkg-query"]);
  });
}
for (const [label, row] of [
  ["retained version", "nftables\t1.1.3-1\tnot-installed\tok"],
  ["retained configuration", "nftables\t1.1.3-1\tconfig-files\tok"],
  ["partial installation", "nftables\t1.1.3-1\tunpacked\tok"],
  ["error flag", "nftables\t\tnot-installed\treinstreq"],
  ["foreign Docker architecture", "docker-ce:arm64\t\tnot-installed\tok"],
  ["foreign dependency architecture", "libnftables1:arm64\t\tnot-installed\tok"],
  ["duplicate absence", "nftables\t\tnot-installed\tok\nnftables\t\tnot-installed\tok"],
] as const) {
  test(`the privileged hook refuses changed or ambiguous absent state: ${label}`, async () => {
    const { debianScenario } = await import("./fixtures/apt-debian-scenario.ts");
    const result = await debianScenario({ absentNftablesRecord: true, guardInventory: [row] });
    expect(result.privilegedPlans).toBe(1);
    expect(result.installs).toBe(0);
    expect(result.configured).toEqual(result.baseline);
    expect(result.outcome.exitCode).toBe(3);
  });
}
