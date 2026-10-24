import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const repository = resolve(import.meta.dir, "../..");
async function command(args: string[], cwd: string, env: Record<string, string>, input?: Uint8Array) {
  const child = Bun.spawn(args, { cwd, env, stdin: input ? Buffer.from(input) : "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test("the fixed Debian13 builder emits only authenticated Trixie internal policy with deliberately unverified internal readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-candidate-debian13-"));
  try {
    const bin = join(root, "bin"); await mkdir(bin); await symlink(process.execPath, join(bin, "bun"));
    const environment = { PATH: bin, HOME: root, TMPDIR: root };
    const output = join(root, "artifacts");
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output, "--fixture", "debian13-amd64"], repository, environment);
    expect(built.exit, built.stderr).toBe(0);
    const report = JSON.parse(built.stdout);
    expect(report).toMatchObject({ catalogId: "debian-13-amd64-docker-2026-10-19", internalArtifact: true, artifactAuthentication: "authenticated", installationEvidence: "pending", runtimeSupport: "unverified" });
    expect(report.artifacts.map((item: { name: string }) => item.name).sort()).toEqual(["containerd.io", "docker-buildx-plugin", "docker-ce", "docker-ce-cli", "docker-compose-plugin", "libjansson4", "libnftables1", "nftables"]);
    const internal = join(root, "internal"); const ordinary = join(root, "ordinary"); await mkdir(internal); await mkdir(ordinary);
    for (const [filename, destination] of [["fleur-internal-native-candidate.tgz", internal], ["fleur-ordinary.tgz", ordinary]]) {
      const extracted = await command(["/usr/bin/tar", "-xf", "-", "-C", destination!], root, environment, Bun.gunzipSync(await readFile(join(output, filename!))));
      expect(extracted.exit, extracted.stderr).toBe(0);
    }
    const catalogBytes = await readFile(join(internal, "package/internal-native-candidate-catalog.json"));
    expect(Bun.CryptoHasher.hash("sha256", catalogBytes, "hex")).toBe("032a04d1b44961b92fbccadaf184f3c2695dc5cf6cdec5941a7121a2c785677d");
    expect(report.authentication).toMatchObject({ maintainerScriptsSha256: "a9a9c699e6a73a41e15d12ecfe8d2ac29d70753ce3ca1308589bcccf32631097", maintainerScriptsScope: "trixie-amd64 five packages", nativeExecutionVerified: false });
    const compiled = await command([process.execPath, "-e", `import {candidateProfiles} from ${JSON.stringify(join(internal, "package/bin/native-candidate-catalog.ts"))};console.log(JSON.stringify(candidateProfiles));`], root, environment);
    expect(compiled.exit, compiled.stderr).toBe(0);
    const profiles = JSON.parse(compiled.stdout);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ distribution: "debian", release: "13", architecture: "x64", installationEvidence: "pending", runtimeSupport: "unverified" });
    expect(profiles[0].packages).toEqual({ "docker-ce": "5:29.9.1-1~debian.13~trixie", "docker-ce-cli": "5:29.9.1-1~debian.13~trixie", "containerd.io": "2.4.2-2~debian.13~trixie", "docker-buildx-plugin": "0.38.0-1~debian.13~trixie", "docker-compose-plugin": "5.6.0-1~debian.13~trixie" });
    expect(profiles[0].artifacts["docker-ce"]).toMatchObject({ architecture: "amd64", size: 24553192, sha256: "b33133205350e2765df0cc382f5a3ee44c2cfd4cdc3dc6ba32eca40839ac3574" });
    expect(Object.keys(profiles[0].artifacts)).toHaveLength(5);
    expect(profiles[0].distroDependencies).toMatchObject({ repositoryFingerprint: "04B54C3CDCA79751B16BC6B5225629DF75B188BD", signingFingerprint: "B8E5F13176D2A7A75220028078DBA3BC47EF2265", maintainerScriptsSha256: "c8d9621167b75774c7fa17e07ad845afadaa405b3a38388195383f7314728f17", effects: "nftables-configuration-helper-state-systemd-reload-and-ldconfig" });
    expect(Object.keys(profiles[0].distroDependencies.artifacts).sort()).toEqual(["libjansson4", "libnftables1", "nftables"]);
    for (const artifact of Object.values(profiles[0].distroDependencies.artifacts) as { name: string; sha256: string; size: number; version: string; url: string; architecture: string }[]) {
      expect(artifact.architecture).toBe("amd64");
      const { name, sha256, size, version, url } = artifact;
      expect(report.artifacts.find((item: { name: string }) => item.name === name)).toMatchObject({ name, sha256, size, version, url });
    }
    const frozen = await command([process.execPath, "-e", `import {candidateProfiles} from ${JSON.stringify(join(internal, "package/bin/native-candidate-catalog.ts"))};const p=candidateProfiles[0];console.log(JSON.stringify([candidateProfiles,p,p.packages,p.artifacts,...Object.values(p.artifacts),p.distroDependencies,p.distroDependencies.artifacts,...Object.values(p.distroDependencies.artifacts)].every(Object.isFrozen)));`], root, environment);
    expect(frozen.exit, frozen.stderr).toBe(0);
    expect(JSON.parse(frozen.stdout)).toBe(true);
    expect(await readFile(join(ordinary, "package/src/setup/verified-apt-profiles.json"))).toEqual(await readFile(join(repository, "src/setup/verified-apt-profiles.json")));
    const doctor = await command([process.execPath, join(internal, "package/bin/fleur.ts"), "doctor", "--json"], root, environment);
    expect(doctor.exit).toBe(4);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ command: "doctor", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" } });
    expect(doctor.stderr).toContain("INTERNAL NATIVE CANDIDATE");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

test.each(["debian13-arm64", "debian14-amd64", "debian24-amd64", "__proto__", "../caller.json"])("builder refuses unsupported explicit target %s without output or fallback", async (fixture) => {
  const root = await mkdtemp(join(tmpdir(), "fleur-debian-choice-"));
  try {
    const output = join(root, "output");
    const observed = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output, "--fixture", fixture], repository, { PATH: "", HOME: root, TMPDIR: root });
    expect(observed.exit).toBe(2);
    expect(await readdir(root)).not.toContain("output");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed Trixie policy bytes refuse before candidate output creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-trixie-policy-tamper-"));
  try {
    const environment = { PATH: "", HOME: root, TMPDIR: root };
    const archive = join(root, "source.tgz");
    expect((await command([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], repository, environment)).exit).toBe(0);
    const extracted = await command(["/usr/bin/tar", "-xf", "-", "-C", root], root, environment, Bun.gunzipSync(await readFile(archive)));
    expect(extracted.exit, extracted.stderr).toBe(0);
    const source = join(root, "package"); await mkdir(join(source, "scripts"));
    for (const name of ["build-native-candidate.ts", "native-candidate-ubuntu24-amd64.json", "native-candidate-ubuntu26-amd64.json", "native-candidate-debian13-amd64.json", "candidate-command-observer.ts"]) await copyFile(join(repository, "scripts", name), join(source, "scripts", name));
    const record = join(source, "scripts/native-candidate-debian13-amd64.json");
    await writeFile(record, (await readFile(record, "utf8")).replace('"distribution": "debian"', '"distribution": "ubuntu"'));
    const observed = await command([process.execPath, join(source, "scripts/build-native-candidate.ts"), "--out", join(root, "output"), "--fixture", "debian13-amd64"], source, environment);
    expect(observed.exit).toBe(1);
    expect(observed.stderr).toContain("source-owned candidate catalog changed");
    expect(await readdir(root)).not.toContain("output");
  } finally { await rm(root, { recursive: true, force: true }); }
});
