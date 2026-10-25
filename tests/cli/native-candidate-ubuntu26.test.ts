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
async function extract(archive: string, destination: string, cwd: string, environment: Record<string, string>) {
  return command(["/usr/bin/tar", "-xf", "-", "-C", destination], cwd, environment, Bun.gunzipSync(await readFile(archive)));
}
test("the fixed Ubuntu26 builder emits only Resolute internal policy while ordinary admission stays unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-candidate-ubuntu26-"));
  try {
    const bin = join(root, "bin"); await mkdir(bin); await symlink(process.execPath, join(bin, "bun"));
    const environment = { PATH: bin, HOME: root, TMPDIR: root };
    const output = join(root, "artifacts");
    const built = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output, "--fixture", "ubuntu26-amd64"], repository, environment);
    expect(built.exit, built.stderr).toBe(0);
    const report = JSON.parse(built.stdout);
    expect(report).toMatchObject({ catalogId: "ubuntu-26.04-amd64-docker-2026-10-19", internalArtifact: true, artifactAuthentication: "authenticated", installationEvidence: "pending", runtimeSupport: "unverified" });
    const internal = join(root, "internal"); const ordinary = join(root, "ordinary"); await mkdir(internal); await mkdir(ordinary);
    const extractedInternal = await extract(join(output, "fleur-internal-native-candidate.tgz"), internal, root, environment);
    const extractedOrdinary = await extract(join(output, "fleur-ordinary.tgz"), ordinary, root, environment);
    expect(extractedInternal.exit, extractedInternal.stderr).toBe(0);
    expect(extractedOrdinary.exit, extractedOrdinary.stderr).toBe(0);
    const sourceCatalog = join(internal, "package/internal-native-candidate-catalog.json");
    expect(await Bun.file(sourceCatalog).exists()).toBe(true);
    expect(Bun.CryptoHasher.hash("sha256", await readFile(sourceCatalog), "hex")).toBe("e1d4756d2b9d6ce7dfccff783bb64e50bde09be1c36a8c36f1a2d4577937eb3a");
    const compiled = await command([process.execPath, "-e", `import {candidateProfiles} from ${JSON.stringify(join(internal, "package/bin/native-candidate-catalog.ts"))};console.log(JSON.stringify(candidateProfiles));`], root, environment);
    expect(compiled.exit, compiled.stderr).toBe(0);
    const [profile] = JSON.parse(compiled.stdout);
    expect(profile).toMatchObject({ distribution: "ubuntu", release: "26.04", architecture: "x64", installationEvidence: "pending", runtimeSupport: "unverified" });
    expect(profile.packages).toEqual({ "docker-ce": "5:29.9.1-1~ubuntu.26.04~resolute", "docker-ce-cli": "5:29.9.1-1~ubuntu.26.04~resolute", "containerd.io": "2.4.2-2~ubuntu.26.04~resolute", "docker-buildx-plugin": "0.38.0-1~ubuntu.26.04~resolute", "docker-compose-plugin": "5.6.0-1~ubuntu.26.04~resolute" });
    expect(profile.artifacts["docker-ce"]).toMatchObject({ architecture: "amd64", size: 24584460, sha256: "cb283f77ac1a9e010d1dbe656be58063617e1360ca9f48e5ebe61cf72d2ac96b" });
    expect(report.authentication.maintainerScriptsSha256).toBe("64a17191916b0570d482fd7c479a64528cd57f7162d360679bd6e07fff123451");
    expect(await readFile(join(ordinary, "package/src/setup/verified-apt-profiles.json"))).toEqual(await readFile(join(repository, "src/setup/verified-apt-profiles.json")));
    const doctor = await command([process.execPath, join(internal, "package/bin/fleur.ts"), "doctor", "--json"], root, environment);
    expect(doctor.exit).toBe(4);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ command: "doctor", ok: false, error: { code: "PREREQUISITE_UNAVAILABLE" } });
    expect(doctor.stderr).toContain("INTERNAL NATIVE CANDIDATE");
    const help = await command([process.execPath, join(internal, "package/bin/fleur.ts"), "--help", "--json"], root, environment);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("db backup");
    expect(help.stdout).toContain("db inspect");
    expect(help.stdout).toContain("db recover");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 25000);

for (const fixture of ["ubuntu26-arm64", "ubuntu27-amd64", "../caller-profile.json"]) {
  test(`builder refuses non-source-owned fixture ${fixture}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "fleur-candidate-choice-"));
    try {
      const output = join(root, "output");
      const observed = await command([process.execPath, join(repository, "scripts/build-native-candidate.ts"), "--out", output, "--fixture", fixture], repository, { PATH: "", HOME: root, TMPDIR: root });
      expect(observed.exit).toBe(2);
      expect(await Bun.file(join(output, "fleur-internal-native-candidate.tgz")).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
test("modified Resolute policy bytes fail before any candidate output is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleur-candidate-resolute-tamper-"));
  try {
    const environment = { PATH: "", HOME: root, TMPDIR: root };
    const archive = join(root, "source.tgz");
    expect((await command([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], repository, environment)).exit).toBe(0);
    const extracted = await extract(archive, root, root, environment);
    expect(extracted.exit, extracted.stderr).toBe(0);
    const source = join(root, "package"); await mkdir(join(source, "scripts"));
    for (const name of ["build-native-candidate.ts", "native-candidate-ubuntu24-amd64.json", "native-candidate-ubuntu26-amd64.json", "candidate-command-observer.ts"]) await copyFile(join(repository, "scripts", name), join(source, "scripts", name));
    const record = join(source, "scripts/native-candidate-ubuntu26-amd64.json");
    await writeFile(record, (await readFile(record, "utf8")).replace('"release": "26.04"', '"release": "24.04"'));
    const observed = await command([process.execPath, join(source, "scripts/build-native-candidate.ts"), "--out", join(root, "output"), "--fixture", "ubuntu26-amd64"], source, environment);
    expect(observed.exit).toBe(1);
    expect(observed.stderr).toContain("source-owned candidate catalog changed");
    expect(await readdir(root)).not.toContain("output");
  } finally { await rm(root, { recursive: true, force: true }); }
});
