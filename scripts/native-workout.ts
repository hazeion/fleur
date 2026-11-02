import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import workoutPin from "./workout-source.json";

type Command = (args: string[], timeout?: number, allowed?: number[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
interface Options { repository: string; source: string; scratch: string; port: number; sshOptions: string[]; bunSha256: string; command: Command }
/** Source-only packs retain their original commits and contain no checkout credentials or history. */
async function sourcePack(directory: string, destination: string, command: Command, expected?: string) {
  assert.equal((await lstat(directory)).isDirectory(), true);
  const commit = (await command(["git", "-C", directory, "rev-parse", "HEAD"])).stdout.trim();
  assert.match(commit, /^[a-f0-9]{40}$/); if (expected) assert.equal(commit, expected);
  await command(["git", "-C", directory, "diff", "--exit-code", "HEAD"]);
  const objects = (await command(["git", "-C", directory, "rev-list", "--objects", "--no-object-names", `${commit}^{tree}`])).stdout;
  assert.match(objects, /^(?:[a-f0-9]{40}\n)+$/); assert.ok(objects.length < 1024 * 1024);
  await writeFile(destination, "", { flag: "wx", mode: 0o600 });
  const child = Bun.spawn(["git", "-C", directory, "pack-objects", "--stdout"], { stdin: "pipe", stdout: Bun.file(destination), stderr: "ignore", timeout: 60000, killSignal: "SIGKILL" });
  await child.stdin.write(objects + commit + "\n"); await child.stdin.end();
  assert.equal(await child.exited, 0);
  const metadata = await lstat(destination); assert.ok(metadata.isFile() && metadata.size > 0 && metadata.size <= 16 * 1024 * 1024);
  return { commit, bytes: metadata.size, sha256: Bun.CryptoHasher.hash("sha256", await readFile(destination), "hex") };
}
/** Append the packed application/production proof to an already-qualified owned native Debian guest. */
export async function nativeWorkout({ repository, source, scratch, port, sshOptions, bunSha256, command }: Options): Promise<Record<string, unknown>> {
  assert.match(bunSha256, /^[a-f0-9]{64}$/);
  const metadata = { formatVersion: 1, bunSha256, fleur: await sourcePack(repository, join(scratch, "fleur-source.pack"), command), workout: await sourcePack(source, join(scratch, "workout-source.pack"), command, workoutPin.commit) };
  const manifest = join(scratch, "native-workout-source.json");
  await writeFile(manifest, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
  await command(["scp", ...sshOptions, "-P", String(port), manifest, join(scratch, "fleur-source.pack"), join(scratch, "workout-source.pack"), join(repository, "scripts/native-workout-guest.py"), "fleur@127.0.0.1:lab/"], 120000);
  const observed = await command(["ssh", ...sshOptions, "-p", String(port), "fleur@127.0.0.1", "cd lab && python3 -I native-workout-guest.py"], 1_200_000, [0, 1]);
  const report: Record<string, unknown> = JSON.parse(observed.stdout);
  assert.equal(report.formatVersion, 1); assert.equal(report.scope, "native-debian-workout-production");
  return { ...report, sourcePacks: metadata, exitCode: observed.exitCode };
}
