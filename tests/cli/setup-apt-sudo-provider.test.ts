import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import catalog24 from "../../scripts/native-candidate-ubuntu24-amd64.json";
import catalog from "../../scripts/native-candidate-ubuntu26-amd64.json";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands, type HostCommandResult } from "../../src/setup/commands.ts";
import type { AptInstallProfile } from "../../src/setup/native.ts";
import { aptAccessFixture } from "./fixtures/apt-access.ts";
const profile = { ...catalog.profile, artifacts: Object.fromEntries(catalog.artifacts.map(({ name, version, url, sha256, size }) => [name, { name, version, url, sha256, size, architecture: "amd64" }])) } as unknown as AptInstallProfile;
const target = "/usr/lib/cargo/bin/sudo";
async function fixture26(release: "24.04" | "26.04" = "26.04") {
  const activeProfile = release === "26.04" ? profile : { ...catalog24.profile, artifacts: Object.fromEntries(catalog24.artifacts.map(({ name, version, url, sha256, size }) => [name, { name, version, url, sha256, size, architecture: "amd64" }])) } as unknown as AptInstallProfile;
  const fixture = await aptAccessFixture();
  const original = fixture.host.run;
  fixture.host.host = async () => ({ system: "linux", architecture: "x64", translated: false, distribution: "ubuntu", release, machineId: "a".repeat(64) });
  fixture.host.run = async (args): Promise<HostCommandResult> => {
    if (args[0] === "docker" && args.includes("info") && !fixture.state.active) { fixture.calls.push([...args]); return { status: "completed", exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }; }
    const done = (stdout = ""): HostCommandResult => ({ status: "completed", exitCode: 0, stdout, stderr: "" });
    if (args[0] === "dpkg-query") { fixture.calls.push([...args]); return done(Object.entries(activeProfile.packages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n") + (args.at(-1)?.startsWith("--showformat=") ? "\nsudo-rs\t0.2.13-0ubuntu1.2\tinstalled\tok\n" : "\n")); }
    if (["/usr/bin/sudo", "/etc/alternatives/sudo", target, "/", "/etc", "/usr", "/usr/bin", "/usr/lib", "/etc/alternatives", "/usr/lib/cargo", "/usr/lib/cargo/bin"].includes(args.at(-1)!) && ["/usr/bin/stat", "/usr/bin/readlink", "/usr/bin/dpkg-query"].includes(args[0]!)) {
      fixture.calls.push([...args]); const path = args.at(-1)!;
      if (args[0] === "/usr/bin/stat") return done(`${path === target ? "regular file|0|4755|1" : path === "/usr/bin/sudo" || path === "/etc/alternatives/sudo" ? "symbolic link|0|777|1" : "directory|0|755"}\n`);
      if (args[0] === "/usr/bin/readlink") return done(`${args.includes("--canonicalize-existing") ? path === "/usr/bin/sudo" || path === "/etc/alternatives/sudo" ? target : path : path === "/usr/bin/sudo" ? "/etc/alternatives/sudo" : target}\n`);
      return done(`sudo-rs: ${target}\n`);
    }
    if (args[0] === "/usr/bin/dpkg" && args.includes("--verify")) { fixture.calls.push([...args]); return done(); }
    return original(args);
  };
  return { ...fixture, handlers: setupCommands(fixture.host, [activeProfile]) };
}
test("Ubuntu 26 default package-owned sudo-rs permits separately authorized enrollment", async () => {
  const fixture = await fixture26(); fixture.state.enrolled = false;
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["target", "alias-owner", "alias-route", "target-mode", "target-links", "package-owner", "package-integrity", "package-warning", "package-uncertain", "package-health", "directory-mode", "ancestor-mode", "ancestor-alias", "deadline", "changed-after-prompt", "ancestor-after-prompt"] as const)("unsafe sudo-rs %s cannot execute enrollment", async (kind) => {
  const fixture = await fixture26(); fixture.state.enrolled = false;
  const run = fixture.host.run; let prompted = false;
  const confirm = fixture.host.confirmHuman;
  fixture.host.confirmHuman = async (plan) => { prompted = true; return confirm(plan); };
  fixture.host.run = async (args) => {
    const result = await run(args);
    if ((kind === "target" || kind === "changed-after-prompt" && prompted) && args[0] === "/usr/bin/readlink" && args.at(-1) === "/usr/bin/sudo") return { ...result, stdout: "/tmp/unknown-sudo\n" };
    if (kind === "alias-owner" && args[0] === "/usr/bin/stat" && args.at(-1) === "/etc/alternatives/sudo") return { ...result, stdout: "symbolic link|1000|777|1\n" };
    if (kind === "alias-route" && args[0] === "/usr/bin/readlink" && !args.includes("--canonicalize-existing") && args.at(-1) === "/usr/bin/sudo") return { ...result, stdout: "/tmp/indirect-link\n" };
    if ((kind === "target-mode" || kind === "target-links") && args[0] === "/usr/bin/stat" && args.at(-1) === target) return { ...result, stdout: kind === "target-mode" ? "regular file|0|4777|1\n" : "regular file|0|4755|2\n" };
    if (kind === "package-owner" && args[0] === "/usr/bin/dpkg-query" && args.at(-1) === target) return { ...result, stdout: `unknown: ${target}\n` };
    if (kind === "package-uncertain" && args[0] === "/usr/bin/dpkg") return { ...result, terminationUnconfirmed: true };
    if (kind === "package-warning" && args[0] === "/usr/bin/dpkg") return { ...result, stderr: "verification incomplete\n" };
    if (kind === "package-health" && args[0] === "dpkg-query") return { ...result, stdout: result.stdout.replace(/sudo-rs[^\n]*\n/g, "") };
    if (kind === "package-integrity" && args[0] === "/usr/bin/dpkg") return { ...result, stdout: `??5?????? ${target}\n` };
    if (kind === "ancestor-alias" && args[0] === "/usr/bin/readlink" && args.at(-1) === "/usr/lib") return { ...result, stdout: "/tmp/aliased-lib\n" };
    if (kind === "ancestor-after-prompt" && prompted && args[0] === "/usr/bin/stat" && args.at(-1) === "/usr/bin") return { ...result, stdout: "directory|0|777\n" };
    if (kind === "ancestor-mode" && args[0] === "/usr/bin/stat" && args.at(-1) === "/usr/lib") return { ...result, stdout: "directory|0|777\n" };
    if (kind === "directory-mode" && args[0] === "/usr/bin/stat" && args.at(-1) === "/usr/lib/cargo/bin") return { ...result, stdout: "directory|0|777\n" };
    if (kind === "deadline" && args[0] === "/usr/bin/readlink" && args.at(-1) === "/usr/bin/sudo") return { ...result, status: "timeout", exitCode: undefined };
    return result;
  };
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(4);
    expect(result.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(fixture.prompts).toEqual(kind.endsWith("after-prompt") ? ["docker-access"] : []);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.state.enrolled).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("Ubuntu 26 sudo-rs service startup keeps its separate authority and consumes it once", async () => {
  const fixture = await fixture26(); fixture.state.active = false; fixture.state.containerdActive = false;
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.data).toMatchObject({ setupAction: { action: "service-start", state: "completed" } });
    expect(fixture.prompts).toEqual(["service-start"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "--system", "--no-ask-password", "--job-mode=fail", "start", "docker.service"]]);
    const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(grants.result.data).toMatchObject({ grants: [{ action: "service-start", revoked: true }] });
    expect(fixture.calls.some((args) => args.includes("enable") || args.includes("restart") || args.includes("usermod"))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("Ubuntu 24 does not acquire authority for the Ubuntu 26 sudo alternatives layout", async () => {
  const fixture = await fixture26("24.04"); fixture.state.enrolled = false;
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(4);
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
