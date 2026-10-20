import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { runCli } from "../../src/cli/main.ts";
import { aptAccessFixture } from "./fixtures/apt-access.ts";
test("an already enrolled Docker user with a stale session needs a new login without another privilege action", async () => {
  const fixture = await aptAccessFixture();
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.error?.code).toBe("HUMAN_ACTION_REQUIRED");
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" }, resumable: true });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0]?.includes("sudo") || args.includes("usermod") || args.includes("start") || args.includes("enable"))).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("missing membership requires a separate scoped privilege grant and authorized append leaves the session needing login", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  try {
    const plan = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(plan.exitCode).toBe(3);
    expect(plan.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(plan.result.data).toMatchObject({ plan: { action: "docker-access", method: "docker-official-apt", privilege: "root-equivalent daemon access", user: { name: "alice", uid: process.getuid!() }, group: { name: "docker", gid: 60000 } } });
    expect(fixture.prompts).toEqual([]);
    const changed = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(changed.exitCode).toBe(3);
    expect(changed.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.confirmations[0]?.target).toContain("root-equivalent daemon access");
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
    const rerun = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(rerun.exitCode).toBe(3);
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["timeout", "truncated"] as const)("uncertain %s enrollment retains its fence and blocks doctor RPC or replay", async (kind) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    if (args[0] === "/usr/bin/sudo") { fixture.calls.push([...args]); return { status: kind === "timeout" ? "timeout" : "completed", exitCode: 0, terminationUnconfirmed: kind === "truncated", stdout: "", stderr: "" }; }
    return run(args);
  };
  try {
    const first = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(first.exitCode).toBe(5);
    const rpcBefore = fixture.calls.filter((args) => args.includes("info")).length;
    const diagnostic = await runCli(["doctor", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(diagnostic.exitCode).toBe(5);
    const retried = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(retried.exitCode).toBe(5);
    expect(fixture.calls.filter((args) => args.includes("info"))).toHaveLength(rpcBefore);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
    expect(fixture.prompts).toEqual(["docker-access"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a confirmed OS authorization failure consumes once authority and preserves membership", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => args[0] === "/usr/bin/sudo" ? (fixture.calls.push([...args]), { status: "completed", exitCode: 1, stdout: "", stderr: "sudo: a password is required" }) : run(args);
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(fixture.state.enrolled).toBe(false);
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(listed.result.data).toMatchObject({ grants: [{ action: "docker-access", revoked: true }] });
    const id = (listed.result.data as { grants: { id: string }[] }).grants[0]!.id;
    const denied = await runCli(["setup", "--grant", id, "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(denied.exitCode).toBe(3);
    expect(denied.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
    expect(fixture.prompts).toEqual(["docker-access"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("an existing kernel membership denied by OS policy is never enrolled again", async () => {
  const fixture = await aptAccessFixture(); fixture.state.session = true;
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ access: { state: "manual" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("a fresh usable session advances to image authority without another enrollment", async () => {
  const fixture = await aptAccessFixture(); fixture.state.session = true; fixture.state.daemonReady = true;
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ plan: { action: "image-acquire" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["root-group", "wrong-socket", "custom-endpoint", "changed-unit", "changed-after-prompt"] as const)("%s identity cannot acquire or execute enrollment", async (kind) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run; let prompted = false;
  const confirm = fixture.host.confirmHuman;
  fixture.host.confirmHuman = async (plan) => { prompted = true; return confirm(plan); };
  fixture.host.run = async (args) => {
    const result = await run(args);
    if (kind === "root-group" && args[0] === "/usr/bin/getent" && args.includes("group")) return { ...result, stdout: "docker:x:0:bob\n" };
    if ((kind === "wrong-socket" || kind === "changed-after-prompt" && prompted) && args.includes("--format=%d|%i|%F|%u|%g|%a")) return { ...result, stdout: "1|999|socket|0|60001|660\n" };
    if (kind === "custom-endpoint" && args[0] === "docker" && args.includes("inspect") && args.includes("context")) return { ...result, stdout: '{"Host":"unix:///home/alice/docker.sock"}' };
    if (kind === "changed-unit" && args[0] === "/usr/bin/sha256sum") return { ...result, stdout: `wrong  ${args.at(-1)}\n` };
    return result;
  };
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect([3, 4]).toContain(result.exitCode);
    expect(fixture.state.enrolled).toBe(false);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.prompts).toEqual(kind === "changed-after-prompt" ? ["docker-access"] : []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("a missing selected access grant never falls back to interactive authority", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  try {
    const result = await runCli(["setup", "--grant", "d0b18b63-bb7b-4d70-bc4b-11c0e45b2f17"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["create", "remove"] as const)("access pending fence %s durability failure blocks retry authority", async (phase) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const { readdir } = await import("node:fs/promises"); let seen = false;
  Object.assign(fixture.host, { syncDirectory: async (directory: string) => {
    const pending = (await readdir(directory)).includes("linux-docker-access-pending.json");
    if (phase === "create" && pending || phase === "remove" && seen && !pending) throw new Error("Injected directory fsync failure");
    if (pending) seen = true;
  } });
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(5);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(phase === "create" ? 0 : 1);
    const retried = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(retried.exitCode).toBe(5);
    expect(fixture.prompts).toEqual(["docker-access"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test.each(["install-action", "wrong-method", "changed-checksum", "revoked"] as const)("%s grants cannot authorize Docker user enrollment", async (kind) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => args[0] === "/usr/bin/sudo" ? (fixture.calls.push([...args]), { status: "completed", exitCode: 1, stdout: "", stderr: "authentication required" }) : run(args);
  try {
    await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = `${fixture.root}/state/grants.json`;
    const store = JSON.parse(await readFile(path, "utf8")); const grant = store.grants[0];
    grant.revoked = kind === "revoked";
    if (kind === "install-action") grant.action = "install";
    if (kind === "wrong-method") grant.method = "arch-official-pacman";
    if (kind === "changed-checksum") grant.planChecksum = "f".repeat(64);
    await writeFile(path, JSON.stringify(store));
    const result = await runCli(["setup", "--grant", grant.id, "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.exitCode).toBe(3);
    expect(result.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
    expect(fixture.prompts).toEqual(["docker-access"]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
test("a duplicate numeric GID cannot redirect enrollment away from the named Docker group", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run; let otherGroupChanged = false;
  fixture.host.run = async (args) => {
    if (args[0] === "/usr/bin/getent" && args.includes("group") && args.at(-1) === "60000") return { status: "completed", exitCode: 0, stdout: "other:x:60000:bob\n", stderr: "" };
    if (args[0] === "/usr/bin/sudo") {
      fixture.calls.push([...args]);
      const selected = args[args.indexOf("--groups") + 1];
      // Shadow resolves numeric input by GID; that reverse lookup may name another group.
      if (selected === "60000") otherGroupChanged = true;
      if (selected === "docker") fixture.state.enrolled = true;
      return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
    }
    if (otherGroupChanged && args[0] === "/usr/bin/id" && args.includes("alice")) return { status: "completed", exitCode: 0, stdout: "60001 60002 60000\n", stderr: "" };
    return run(args);
  };
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(otherGroupChanged).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a coherently running Docker socket permits separately authorized user enrollment", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    return args[0] === "/usr/bin/systemctl" && args.at(-1) === "docker.socket" ? { ...result, stdout: result.stdout.replace("SubState=listening", "SubState=running") } : result;
  };
  try {
    const plan = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(plan.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(plan.result.data).toMatchObject({ plan: { action: "docker-access", method: "docker-official-apt" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
    expect(fixture.calls.some((args) => args.includes("start") || args.includes("enable") || args.includes("restart"))).toBe(false);
    const retried = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(retried.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test.each(["socket-transition", "inactive-service", "service-transition", "service-exited", "custom-socket", "wrong-provenance", "wrong-group"] as const)("running-socket enrollment still refuses %s evidence", async (mode) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    const full = args.some((arg) => arg.startsWith("--property=") && arg.includes("UnitFileState"));
    if (args[0] === "/usr/bin/systemctl" && args.at(-1) === "docker.socket") {
      let stdout = result.stdout.replace("SubState=listening", "SubState=running");
      if (full && mode === "socket-transition") stdout = stdout.replace("ActiveState=active", "ActiveState=activating").replace("SubState=running", "SubState=start-chown");
      if (full && mode === "custom-socket") stdout = stdout.replace("DropInPaths=", "DropInPaths=/etc/systemd/system/docker.socket.d/custom.conf");
      return { ...result, stdout };
    }
    if (full && args.at(-1) === "docker.service") {
      if (mode === "inactive-service") return { ...result, stdout: result.stdout.replace("ActiveState=active", "ActiveState=inactive").replace("SubState=running", "SubState=dead") };
      if (mode === "service-transition") return { ...result, stdout: result.stdout.replace("ActiveState=active", "ActiveState=activating").replace("SubState=running", "SubState=start") };
      if (mode === "service-exited") return { ...result, stdout: result.stdout.replace("SubState=running", "SubState=exited") };
    }
    if (mode === "wrong-provenance" && args[0] === "/usr/bin/sha256sum") return { ...result, stdout: `wrong  ${args.at(-1)}\n` };
    if (mode === "wrong-group" && args.includes("--format=%d|%i|%F|%u|%g|%a")) return { ...result, stdout: "1|500|socket|0|60001|660\n" };
    return result;
  };
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.state.enrolled).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("present empty systemd Job metadata permits a separately authorized enrollment plan", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    return args[0] === "/usr/bin/systemctl" && args.some((arg) => arg.startsWith("--property=") && arg.includes("Job")) ? { ...result, stdout: result.stdout.replace("Job=0", "Job=") } : result;
  };
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(result.result.data).toMatchObject({ plan: { action: "docker-access", method: "docker-official-apt" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.state.enrolled).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("the implicit system.slice Docker socket dependency permits an enrollment plan", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    return args[0] === "/usr/bin/systemctl" && args.at(-1) === "docker.socket" && args.some((arg) => arg.startsWith("--property=") && arg.includes("Requires")) ? { ...result, stdout: result.stdout.replace("Requires=sysinit.target", "Requires=sysinit.target system.slice") } : result;
  };
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(result.result.data).toMatchObject({ plan: { action: "docker-access", method: "docker-official-apt" } });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("combined v255 idle jobs, implicit slice and running socket preserve scoped enrollment", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    if (args[0] !== "/usr/bin/systemctl") return result;
    let stdout = result.stdout.replace("Job=0", "Job=");
    if (args.at(-1) === "docker.socket") stdout = stdout.replace("Requires=sysinit.target", "Requires=sysinit.target system.slice").replace("SubState=listening", "SubState=running");
    return { ...result, stdout };
  };
  try {
    const plan = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(plan.result.error?.code).toBe("AUTHORITY_REQUIRED");
    expect(plan.result.data).toMatchObject({ plan: { action: "docker-access" } });
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toEqual([["/usr/bin/sudo", "-n", "/usr/sbin/usermod", "--append", "--groups", "docker", "--", "alice"]]);
    expect(fixture.calls.some((args) => args.includes("start") || args.includes("enable") || args.includes("restart"))).toBe(false);
    const again = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(again.result.data).toMatchObject({ access: { state: "new-login-required" } });
    expect(fixture.prompts).toEqual(["docker-access"]);
    expect(fixture.calls.filter((args) => args[0] === "/usr/bin/sudo")).toHaveLength(1);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test.each(["missing-job", "positive-job", "job-whitespace", "malformed-job", "duplicate-job", "foreign-slice", "extra-require", "socket-wants", "static-unit", "runtime-enabled-unit"] as const)("v255 metadata still refuses %s before enrollment authority", async (mode) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    if (args[0] !== "/usr/bin/systemctl" || !args.some((arg) => arg.startsWith("--property=") && arg.includes("Job"))) return result;
    let stdout = result.stdout.replace("Job=0", "Job=");
    if (args.at(-1) === "docker.socket") {
      stdout = stdout.replace("Requires=sysinit.target", "Requires=sysinit.target system.slice").replace("SubState=listening", "SubState=running");
      if (mode === "missing-job") stdout = stdout.split("\n").filter((line) => line !== "Job=").join("\n");
      if (mode === "positive-job") stdout = stdout.replace("Job=", "Job=12");
      if (mode === "job-whitespace") stdout = stdout.replace("Job=", "Job=0 ");
      if (mode === "malformed-job") stdout = stdout.replace("Job=", "Job=none");
      if (mode === "duplicate-job") stdout = stdout.replace("Job=", "Job=\nJob=0");
      if (mode === "foreign-slice") stdout = stdout.replace("Requires=sysinit.target system.slice", "Requires=sysinit.target other.slice");
      if (mode === "extra-require") stdout = stdout.replace("Requires=sysinit.target system.slice", "Requires=sysinit.target system.slice other.service");
      if (mode === "socket-wants") stdout = stdout.replace("Wants=", "Wants=system.slice");
      if (mode === "static-unit") stdout = stdout.replace("UnitFileState=disabled", "UnitFileState=static");
      if (mode === "runtime-enabled-unit") stdout = stdout.replace("UnitFileState=disabled", "UnitFileState=enabled-runtime");
    }
    return { ...result, stdout };
  };
  try {
    const result = await runCli(["setup"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
    expect(fixture.state.enrolled).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("trailing Job value whitespace is not normalized into an idle unit", async () => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    if (args[0] === "/usr/bin/systemctl" && args.some((arg) => arg.startsWith("--property=") && arg.includes("Job"))) return { ...result, stdout: result.stdout.split("\n").filter((line) => !line.startsWith("Job=")).join("\n") + "\nJob= \t\n" };
    return result;
  };
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.error?.code).toBe("PREREQUISITE_UNAVAILABLE");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test.each(["", "0", "0 ", "12", "\u0000"])("last-position Job value %j retains its exact meaning", async (job) => {
  const fixture = await aptAccessFixture(); fixture.state.enrolled = false;
  const run = fixture.host.run;
  fixture.host.run = async (args) => {
    const result = await run(args);
    if (args[0] === "/usr/bin/systemctl" && args.some((arg) => arg.startsWith("--property=") && arg.includes("Job"))) return { ...result, stdout: result.stdout.split("\n").filter((line) => !line.startsWith("Job=")).join("\n") + `\nJob=${job}\n` };
    return result;
  };
  try {
    const result = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: fixture.handlers });
    expect(result.result.error?.code).toBe(job === "" || job === "0" ? "AUTHORITY_REQUIRED" : "PREREQUISITE_UNAVAILABLE");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls.some((args) => args[0] === "/usr/bin/sudo")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
