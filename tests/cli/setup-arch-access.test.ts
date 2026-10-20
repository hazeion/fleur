import { test, expect } from "bun:test";
import { rm } from "node:fs/promises";
import { runCli } from "../../src/cli/main.ts";
import { archAccessFixture } from "./fixtures/arch-access.ts";
test("an already enrolled Arch Docker user with a stale session needs login without enrollment or startup", async () => {
  const fixture = await archAccessFixture();
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || args.includes("start") || args.includes("enable"))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("Arch enrollment needs its own root-equivalent grant and uses the shadow-owned named-group tool", async () => {
  const fixture = await archAccessFixture(); fixture.state.enrolled = false;
  try {
    const plan = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(plan.exitCode).toBe(3);
    expect(plan.result.data).toMatchObject({ plan: { action: "docker-access", method: "arch-official-pacman", privilege: "root-equivalent daemon access", group: { name: "docker", gid: 60000 } } });
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.confirmations).toHaveLength(1);
    expect(fixture.confirmations[0]!.target).toContain("root-equivalent daemon access");
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
    expect(fixture.calls.some((args) => args.includes("start") || args.includes("enable") || args.includes("--upgrade") || args[0] === "/usr/bin/dpkg-query")).toBe(false);
    const fresh = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(fresh.exitCode).toBe(3);
    expect(fixture.prompts).toEqual(["docker-access"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["wrong-tool-owner", "fresh-lock", "unhealthy-database", "package-drift"] as const)("Arch %s prevents enrollment without repairing packages or accounts", async (kind) => {
  const fixture = await archAccessFixture(); fixture.state.enrolled = false;
  if (kind === "package-drift") fixture.state.packageDrift = true;
  const run = fixture.host.run;
  Object.assign(fixture.host, { run: async (args: readonly string[]) => {
    if (kind === "fresh-lock" && args[0] === "/usr/bin/stat" && args.at(-1) === "/var/lib/pacman/db.lck") return { status: "completed", exitCode: 0, stdout: "regular file|0|644|1\n", stderr: "" };
    if (kind === "unhealthy-database" && args[0] === "/usr/bin/pacman" && args.includes("--database")) return { status: "completed", exitCode: 1, stdout: "", stderr: "database inconsistent" };
    if (kind === "wrong-tool-owner" && args[0] === "/usr/bin/pacman" && args.at(-1) === "/usr/bin/usermod") return { status: "completed", exitCode: 0, stdout: "foreign-package\n", stderr: "" };
    return run(args, 1000);
  } });
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(4);
    expect(fixture.state.enrolled).toBe(false);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo" || args.includes("--upgrade") || args.includes("--sync") || args.includes("enable") || args.includes("start"))).toBe(false);
    expect(fixture.prompts).toEqual(kind === "wrong-tool-owner" ? ["docker-access"] : []);
    if (kind === "wrong-tool-owner") {
      const grants = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
      expect(grants.result.data).toMatchObject({ grants: [{ action: "docker-access", revoked: false }] });
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["timeout", "truncated"] as const)("Arch uncertain %s enrollment blocks probes and replay even if membership changed", async (kind) => {
  const fixture = await archAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  Object.assign(fixture.host, { run: async (args: readonly string[]) => {
    if (args[0] === "/usr/bin/sudo") { fixture.calls.push([...args]); fixture.state.enrolled = true; return { status: kind === "timeout" ? "timeout" : "completed", exitCode: 0, terminationUnconfirmed: kind === "truncated", stdout: "", stderr: "" }; }
    return run(args, 1000);
  } });
  try {
    expect((await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(5);
    const before = fixture.calls.filter((args) => args.includes("info")).length;
    expect((await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(5);
    expect((await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers })).exitCode).toBe(5);
    expect(fixture.calls.filter((args) => args.includes("info"))).toHaveLength(before);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
    expect(fixture.prompts).toEqual(["docker-access"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("an Arch duplicate GID still enrolls only the named Docker group", async () => {
  const fixture = await archAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run; let otherGroupChanged = false;
  Object.assign(fixture.host, { run: async (args: readonly string[]) => {
    if (args[0] === "/usr/bin/sudo" && args[args.indexOf("--groups") + 1] === "60000") { otherGroupChanged = true; return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; }
    return run(args, 1000);
  } });
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(otherGroupChanged).toBe(false);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("a fresh usable Arch session advances to image authority without new account or service actions", async () => {
  const fixture = await archAccessFixture(); fixture.state.daemonReady = true; fixture.state.session = true;
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ plan: { action: "image-acquire" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
