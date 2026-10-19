import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/cli/main.ts";
import { setupCommands } from "../../src/setup/commands.ts";
import type { DesktopInstallProfile } from "../../src/setup/native.ts";

const profile: DesktopInstallProfile = {
  method: "docker-desktop-official-dmg", artifactAuthentication: "authenticated", nativeEvidence: "pending",
  release: "15.7.7", architecture: "x64", version: "4.96.0", build: "243774",
  url: "https://desktop.docker.com/mac/main/amd64/243774/Docker.dmg",
  sha256: "cdb0a193ba3fc4e1ecaa827061ab1f636df04db60c9bc109a33e2c3a62dad67a", bytes: 659487616, teamId: "9BNSXJN65R",
};
test("Desktop setup exposes authenticated acquisition and placement without granting legal or launch authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-desktop-denied-"));
  const calls: string[][] = [];
  try {
    const outcome = await runCli(["setup", "--json"], { cwd: root, handlers: setupCommands({
      stateDirectory: join(root, "state"),
      host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.7", machineId: "a".repeat(64) }),
      run: async (args) => { calls.push([...args]); return { status: "missing", stdout: "", stderr: "" }; },
    }, [profile]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ plan: { method: "docker-desktop-official-dmg", artifactAuthentication: "authenticated", requiredAuthorities: ["image-acquire", "install"], nativeEvidence: "pending" }, resumable: true });
    expect(calls).toEqual([["docker", "--version"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function desktopFixture() {
  const root = await mkdtemp(join(tmpdir(), "fleur-desktop-install-"));
  const applications = join(root, "Applications");
  await mkdir(applications);
  const calls: string[][] = [];
  const prompts: string[] = [];
  let mounted = "";
  let image = "";
  const payload = "Desktop image fixture";
  const candidate = { ...profile, bytes: Buffer.byteLength(payload), sha256: "fd699df0a81f46a3e423008aac859fcf6a661a066cd57aa09d5727e021f99e07" };
  const host = {
    stateDirectory: join(root, "state"), desktopApplicationsDirectory: applications, interactive: true,
    confirmHuman: async ({ action }: { action: string }): Promise<"once" | "remembered" | "deny"> => { prompts.push(action); return "once"; },
    host: async () => ({ system: "darwin", architecture: "x64", translated: false, release: "15.7.7", machineId: "a".repeat(64) }),
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const done = (stdout = "", stderr = "") => ({ status: "completed" as const, exitCode: 0, stdout, stderr });
      if (args[0] === "docker") return { status: "missing" as const, stdout: "", stderr: "" };
      if (args[0] === "curl") {
        const { dirname, basename } = await import("node:path");
        const { realpath, lstat } = await import("node:fs/promises");
        image = args[args.indexOf("--output") + 1]!;
        expect(basename(image)).toBe("Docker.dmg");
        expect(basename(dirname(image)).startsWith("fleur-desktop-")).toBe(true);
        expect(await realpath(dirname(dirname(image)))).toBe(await realpath(tmpdir()));
        const owned = await lstat(dirname(image));
        expect(owned.uid).toBe(process.getuid!()); expect(owned.mode & 0o077).toBe(0);
        await Bun.write(image, payload); return done();
      }
      if (args[0] === "codesign") {
        expect(args).toContain("--verify"); expect(args).toContain("--strict");
        const requirement = args[args.indexOf("--test-requirement") + 1];
        expect(requirement).toBe(`=anchor apple generic and certificate leaf[subject.OU] = "9BNSXJN65R"${args.at(-1)!.endsWith("Docker.app") ? ' and identifier "com.docker.docker"' : ""}`);
        if (args.at(-1)!.endsWith("Docker.app")) expect(args).toContain("--deep");
        return done();
      }
      if (args[0] === "spctl") return done("", "accepted\nsource=Notarized Developer ID\n");
      if (args[0] === "hdiutil" && args[1] === "attach") {
        mounted = args[args.indexOf("-mountpoint") + 1]!;
        expect(mounted).toBe(join((await import("node:path")).dirname(image), "mounted"));
        expect(args).toContain("-readonly"); expect(args).toContain("-nobrowse"); expect(args).toContain("-noautoopen");
        await mkdir(join(mounted, "Docker.app", "Contents", "MacOS"), { recursive: true });
        await Bun.write(join(mounted, "Docker.app", "Contents", "MacOS", "com.docker.backend"), "owned app");
        return done("attachment fixture");
      }
      if (args[0] === "hdiutil" && args[1] === "info") return done("live fixture");
      if (args[0] === "plutil") {
        const path = args.at(-1)!;
        const entities = [{ "dev-entry": "/dev/disk44", "content-hint": "GUID_partition_scheme" }, { "dev-entry": "/dev/disk44s2", "mount-point": mounted }];
        return done(JSON.stringify(path.endsWith("attach.plist") ? { "system-entities": entities } : { images: [{ "image-path": image, "system-entities": entities }] }));
      }
      if (args[0] === "/usr/libexec/PlistBuddy") return done("4.96.0\n");
      if (args[0] === "lipo") return done("x86_64\n");
      if (args[0] === "ditto") {
        expect(args[1]).toBe(join(mounted, "Docker.app"));
        expect(args[2]!.startsWith(`${applications}/.fleur-desktop-`)).toBe(true);
        const { cp } = await import("node:fs/promises"); await cp(args[1]!, args[2]!, { recursive: true, errorOnExist: true, force: false }); return done(); }
      if (args[0] === "hdiutil" && args[1] === "detach") { expect(args).toEqual(["hdiutil", "detach", "/dev/disk44"]); return done(); }
      throw new Error(`Unexpected Desktop operation ${args[0]}`);
    },
  };
  return { root, applications, calls, prompts, host, candidate };
}
test("authorized Desktop setup authenticates and places the application without launch, legal or configuration actions", async () => {
  const fixture = await desktopFixture();
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ setupAction: { action: "install", state: "completed" }, cleanup: true, nativeSupport: "unverified", resumable: true });
    expect(await Bun.file(join(fixture.applications, "Docker.app", "Contents", "MacOS", "com.docker.backend")).text()).toBe("owned app");
    expect(fixture.prompts).toEqual(["image-acquire", "install"]);
    expect(fixture.calls.some((args) => args.includes("--accept-license") || args[0] === "open" || args[0] === "sudo" || args.at(0)?.endsWith("/install"))).toBe(false);
    expect(fixture.calls.some((args) => args[0] === "hdiutil" && args[1] === "detach")).toBe(true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a replaced private application stage cannot publish or delete the replacement directory", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  let replacement = "";
  let moved = "";
  try {
    fixture.host.run = async (args) => {
      const app = args.at(-1)!;
      if (args[0] === "codesign" && app.includes("/.fleur-desktop-") && app.endsWith("/Docker.app")) {
        const { dirname } = await import("node:path");
        const { rename } = await import("node:fs/promises");
        replacement = dirname(app); moved = `${replacement}-moved`;
        await rename(replacement, moved); await mkdir(replacement); await Bun.write(join(replacement, "unrelated"), "preserve");
      }
      return run(args);
    };
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(5);
    expect(await Bun.file(join(replacement, "unrelated")).text()).toBe("preserve");
    expect(await Bun.file(join(fixture.applications, "Docker.app", "Contents", "MacOS", "com.docker.backend")).exists()).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("Desktop cleanup refuses a changed mounted device identity without detaching it", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  try {
    fixture.host.run = async (args) => {
      const result = await run(args);
      return args[0] === "plutil" && args.at(-1)?.endsWith("live.plist") ? { ...result, stdout: result.stdout.replace("/dev/disk44\"", "/dev/disk45\"") } : result;
    };
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result.data).toMatchObject({ cleanup: false });
    expect(fixture.calls.some((args) => args[0] === "hdiutil" && args[1] === "detach")).toBe(false);
  } finally {
    const image = fixture.calls.find((args) => args[0] === "curl");
    if (image) { const { dirname } = await import("node:path"); await rm(dirname(image[image.indexOf("--output") + 1]!), { recursive: true, force: true }); }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Desktop ownership accepts the canonical image and mount paths returned by macOS", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  try {
    fixture.host.run = async (args) => {
      const result = await run(args);
      if (args[0] !== "plutil") return result;
      const { realpath } = await import("node:fs/promises");
      const record = JSON.parse(result.stdout);
      for (const entry of record.images ?? [record]) {
        if (entry["image-path"]) entry["image-path"] = await realpath(entry["image-path"]);
        for (const part of entry["system-entities"]) if (part["mount-point"]) part["mount-point"] = await realpath(part["mount-point"]);
      }
      return { ...result, stdout: JSON.stringify(record) };
    };
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ cleanup: true, setupAction: { state: "completed" } });
  } finally {
    const image = fixture.calls.find((args) => args[0] === "curl");
    if (image) { const { dirname } = await import("node:path"); await rm(dirname(image[image.indexOf("--output") + 1]!), { recursive: true, force: true }); }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a downloaded Desktop image with the wrong digest is unavailable and never mounted or installed", async () => {
  const fixture = await desktopFixture();
  try {
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [{ ...fixture.candidate, sha256: "0".repeat(64) }]) });
    expect(outcome.exitCode).toBe(4);
    expect(outcome.result.data).toMatchObject({ cleanup: true, setupAction: { state: "incomplete" } });
    expect(fixture.calls.some((args) => ["codesign", "hdiutil", "ditto"].includes(args[0]!))).toBe(false);
    expect(await Bun.file(join(fixture.applications, "Docker.app", "Contents", "MacOS", "com.docker.backend")).exists()).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("Desktop hashing preserves the reserved cleanup budget when a large download uses its operation budget", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  try {
    fixture.host.run = async (args, ...rest: unknown[]) => {
      const result = await run(args);
      if (args[0] === "curl") {
        const { open } = await import("node:fs/promises");
        const file = await open(args[args.indexOf("--output") + 1]!, "r+");
        try { await file.truncate(2 ** 31); } finally { await file.close(); }
        const budget = Number(rest[0]);
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, budget - 100)));
      }
      return result;
    };
    const started = performance.now();
    const outcome = await runCli(["setup", "--timeout", "6"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [{ ...fixture.candidate, bytes: 2 ** 31, sha256: "0".repeat(64) }]) });
    expect(outcome.exitCode).toBe(4);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(fixture.calls.some((args) => args[0] === "hdiutil")).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("an existing Docker application is preserved without grants or download", async () => {
  const fixture = await desktopFixture();
  try {
    await mkdir(join(fixture.applications, "Docker.app"));
    await Bun.write(join(fixture.applications, "Docker.app", "existing"), "user installation");
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(4);
    expect(await Bun.file(join(fixture.applications, "Docker.app", "existing")).text()).toBe("user installation");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls).toEqual([["docker", "--version"]]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a concurrent application appearing before publication is never overwritten", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  try {
    fixture.host.run = async (args) => {
      if (args[0] === "codesign" && args.at(-1)?.includes("/.fleur-desktop-")) {
        await mkdir(join(fixture.applications, "Docker.app"));
        await Bun.write(join(fixture.applications, "Docker.app", "existing"), "concurrent installation");
      }
      return run(args);
    };
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.data).toMatchObject({ cleanup: true, setupAction: { state: "incomplete" } });
    expect(await Bun.file(join(fixture.applications, "Docker.app", "existing")).text()).toBe("concurrent installation");
    expect(await Bun.file(join(fixture.applications, "Docker.app", "Contents", "MacOS", "com.docker.backend")).exists()).toBe(false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("rejected vendor signatures never mount the image and consumed once grants cannot replay", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  try {
    fixture.host.run = async (args) => args[0] === "codesign" ? { status: "completed", exitCode: 1, stdout: "", stderr: "wrong vendor" } : run(args);
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(4);
    expect(fixture.calls.some((args) => args[0] === "hdiutil")).toBe(false);
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(listed.result.data).toMatchObject({ grants: [{ action: "image-acquire", revoked: true }, { action: "install", revoked: true }] });
    const downloads = fixture.calls.filter((args) => args[0] === "curl").length;
    const retry = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(retry.exitCode).toBe(3);
    expect(fixture.calls.filter((args) => args[0] === "curl").length).toBe(downloads);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("busy owned image cleanup reports recovery without forced detachment or false readiness", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  try {
    fixture.host.run = async (args) => {
      const result = await run(args);
      return args[0] === "hdiutil" && args[1] === "detach" ? { ...result, exitCode: 16, stderr: "Resource busy" } : result;
    };
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result.data).toMatchObject({ cleanup: false, nativeSupport: "unverified" });
    expect(fixture.calls.some((args) => args.includes("-force") || args.includes("--force"))).toBe(false);
  } finally {
    const image = fixture.calls.find((args) => args[0] === "curl");
    if (image) { const { dirname } = await import("node:path"); await rm(dirname(image[image.indexOf("--output") + 1]!), { recursive: true, force: true }); }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a replaced inner staged application is preserved for recovery and never published", async () => {
  const fixture = await desktopFixture();
  const run = fixture.host.run;
  let replacement = "";
  try {
    fixture.host.run = async (args) => {
      const result = await run(args);
      const app = args.at(-1)!;
      if (args[0] === "codesign" && app.includes("/.fleur-desktop-") && app.endsWith("/Docker.app")) {
        const { rename } = await import("node:fs/promises");
        replacement = app;
        await rename(app, `${app}.verified-original`);
        await mkdir(app);
        await Bun.write(join(app, "unexpected"), "unsigned replacement");
      }
      return result;
    };
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
    expect(outcome.result.data).toMatchObject({ cleanup: false, setupAction: { state: "incomplete" } });
    expect(await Bun.file(join(fixture.applications, "Docker.app", "unexpected")).exists()).toBe(false);
    expect(await Bun.file(join(replacement, "unexpected")).text()).toBe("unsigned replacement");
    expect(await Bun.file(join(`${replacement}.verified-original`, "Contents", "MacOS", "com.docker.backend")).text()).toBe("owned app");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("malformed private Desktop authority state remains recovery-required without prompts or acquisition", async () => {
  const fixture = await desktopFixture();
  try {
    const { writeFile } = await import("node:fs/promises");
    await mkdir(fixture.host.stateDirectory, { mode: 0o700 });
    await writeFile(join(fixture.host.stateDirectory, "grants.json"), "invalid JSON", { mode: 0o600 });
    const listed = await runCli(["setup", "grants", "list", "--json"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    const outcome = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(listed.exitCode).toBe(5);
    expect(outcome.exitCode).toBe(5);
    expect(outcome.result.error?.code).toBe("RECOVERY_REQUIRED");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.calls).toEqual([["docker", "--version"]]);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("an unwritable Desktop application directory still requests human OS action rather than recovery", async () => {
  const fixture = await desktopFixture();
  const { chmod } = await import("node:fs/promises");
  try {
    await chmod(fixture.applications, 0o500);
    const outcome = await runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(outcome.exitCode).toBe(3);
    expect(outcome.result.error?.code).toBe("HUMAN_ACTION_REQUIRED");
    expect(fixture.calls).toEqual([["docker", "--version"]]);
  } finally { await chmod(fixture.applications, 0o700); await rm(fixture.root, { recursive: true, force: true }); }
});

test("concurrent Desktop setup reports maintenance busy without requesting or using additional authority", async () => {
  const fixture = await desktopFixture();
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  fixture.host.confirmHuman = async ({ action }) => { fixture.prompts.push(action); entered(); await blocked; return "deny"; };
  const first = runCli(["setup"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
  try {
    await waiting;
    const second = await runCli(["setup", "--json"], { cwd: fixture.root, handlers: setupCommands(fixture.host, [fixture.candidate]) });
    expect(second.exitCode).toBe(5);
    expect(second.result.error?.code).toBe("MAINTENANCE_BUSY");
    expect(fixture.prompts).toEqual(["image-acquire"]);
  } finally { release(); await first; await rm(fixture.root, { recursive: true, force: true }); }
});
