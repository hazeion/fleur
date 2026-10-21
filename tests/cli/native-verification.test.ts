import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native verification requires disposable-host opt-in before any prerequisite access", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-native-optin-"));
  try {
    const report = join(scratch, "report.json");
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
      env: { ...process.env, PATH: scratch, FLEUR_OWNED_DISPOSABLE_HOST: undefined, FLEUR_NATIVE_REPORT: report },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
    expect(await child.exited).toBe(1);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.ok).toBe(false);
    expect(observed.error).toBe("Explicit FLEUR_OWNED_DISPOSABLE_HOST=yes opt-in required before Docker access.");
    expect(observed.runs).toEqual([]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});


test("existing Docker verification reports missing image authority without pulling or changing a personal host", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fleur-existing-docker-"));
  try {
    const report = join(scratch, "report.json");
    const calls = join(scratch, "calls.log");
    const docker = join(scratch, "docker");
    await writeFile(docker, `#!/bin/sh
printf '%s\\n' "$*" >> "$FLEUR_TEST_COMMANDS"
case "$*" in
  "context show") printf 'local\\n' ;;
  "context inspect "*) printf '{"Host":"unix:///tmp/fleur-native-fixture.sock"}\\n' ;;
  *" compose version --short") printf '5.6.0\\n' ;;
  *" version --format "*) printf '{"Server":{"Version":"29.9.2"}}\\n' ;;
  *" image inspect "*) printf 'Error response from daemon: No such image: smoke\\n' >&2; exit 1 ;;
  *) exit 97 ;;
esac
`);
    await chmod(docker, 0o700);
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../scripts/verify-native-setup.ts")], {
      env: { ...process.env, PATH: `${scratch}:/usr/bin:/bin:/usr/sbin:/sbin`, DOCKER_CONTEXT: undefined, DOCKER_HOST: undefined, FLEUR_OWNED_DISPOSABLE_HOST: undefined, FLEUR_EXISTING_DOCKER_ONLY: "yes", FLEUR_NATIVE_REPORT: report, FLEUR_TEST_COMMANDS: calls },
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10000,
    });
    expect(await child.exited).toBe(1);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.requiredAction).toEqual({ action: "image-acquire", method: "docker-digest-pull", image: process.arch === "arm64" ? "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023" : "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e" });
    expect(observed.verifiedReleaseProfile).toBe(false);
    expect(observed.runs).toEqual([]);
    const commands = (await readFile(calls, "utf8")).trim().split("\n");
    expect(commands.some((command) => command.includes(" image inspect "))).toBe(true);
    expect(commands.some((command) => /(?:^| )(pull|create|run|rm|start|stop|prune|use)(?: |$)/.test(command))).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
