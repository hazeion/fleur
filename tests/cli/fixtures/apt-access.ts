import { setupCommands, type HostCommandResult } from "../../../src/setup/commands.ts";
const aptPackages = {
  "docker-ce": "5:29.9.1-1~ubuntu.24.04~noble",
  "docker-ce-cli": "5:29.9.1-1~ubuntu.24.04~noble",
  "containerd.io": "2.4.2-2~ubuntu.24.04~noble",
  "docker-compose-plugin": "5.6.0-1~ubuntu.24.04~noble",
  "docker-buildx-plugin": "0.38.0-1~ubuntu.24.04~noble"
};
const aptArtifacts = {
  "docker-ce": {
    "name": "docker-ce",
    "version": "5:29.9.1-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "463a666215797c9f9ea7d0ad1751de5b2b3806a1b539a3550e16822ef34ccbfd",
    "size": 24548040,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce_29.9.1-1~ubuntu.24.04~noble_amd64.deb"
  },
  "docker-ce-cli": {
    "name": "docker-ce-cli",
    "version": "5:29.9.1-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "961968342af4738eb5fb5fc03f9834106c1e454bd010d574cf1a6feae9905efc",
    "size": 17593952,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-ce-cli_29.9.1-1~ubuntu.24.04~noble_amd64.deb"
  },
  "containerd.io": {
    "name": "containerd.io",
    "version": "2.4.2-2~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "7327ab23182425e94b46a91567e9ddf0183f9b3a5ed53d5e2489f000dbf9cfe2",
    "size": 23270672,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/containerd.io_2.4.2-2~ubuntu.24.04~noble_amd64.deb"
  },
  "docker-compose-plugin": {
    "name": "docker-compose-plugin",
    "version": "5.6.0-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "132266d499d9873aafcbe5b515997b8abd714914fa32a62ccac705c1ede7ca81",
    "size": 8079740,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-compose-plugin_5.6.0-1~ubuntu.24.04~noble_amd64.deb"
  },
  "docker-buildx-plugin": {
    "name": "docker-buildx-plugin",
    "version": "0.38.0-1~ubuntu.24.04~noble",
    "architecture": "amd64",
    "sha256": "7094f8b50bc6b239292d475620424a531f7fa0763e466c52ffc3a4037e72bfc5",
    "size": 17783524,
    "url": "https://download.docker.com/linux/ubuntu/dists/noble/pool/stable/amd64/docker-buildx-plugin_0.38.0-1~ubuntu.24.04~noble_amd64.deb"
  }
} as const;
const aptProfile = { method: "docker-official-apt" as const, verified: true as const, distribution: "ubuntu" as const, release: "24.04" as const, architecture: "x64" as const, repositoryFingerprint: "9DC858229FC7DD38854AE2D88D81803C0EBFCD88", packages: aptPackages, artifacts: aptArtifacts };
export async function aptAccessFixture() {
  const { mkdtemp } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = await mkdtemp("/tmp/fleur-apt-service-");
  const calls: string[][] = [];
  const prompts: string[] = [];
  const confirmations: { action: string; target: string }[] = [];
  const state = { active: true, containerdActive: true, enrolled: true, session: false, daemonReady: false };
  const done = (stdout = "", exitCode = 0, stderr = ""): HostCommandResult => ({ status: "completed", exitCode, stdout, stderr });
  const hashes: Record<string, string> = { "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa", "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656", "containerd.service": "bd1effcf6d9cd564c232b631b353b2758f174160e3d8c078a792363b59f113d0" };
  const host = {
    stateDirectory: join(root, "state"), interactive: true,
    confirmHuman: async (plan: { action: string; target: string }) => { const { action } = plan; confirmations.push(plan); prompts.push(action); return "once" as const; },
    host: async () => ({ system: "linux", architecture: "x64", translated: false as const, distribution: "ubuntu", release: "24.04", bootId: "11111111-1111-4111-8111-111111111111", machineId: "a".repeat(64) }),
    run: async (args: readonly string[]): Promise<HostCommandResult> => {
      calls.push([...args]);
      if (args[0] === "/usr/bin/getent") {
        if (args.includes("passwd")) return done(`alice:x:${process.getuid!()}:60001:Alice:/home/alice:/bin/bash\n`);
        return done(`docker:x:60000:${state.enrolled ? "bob,alice" : "bob"}\n`);
      }
      if (args[0] === "/usr/bin/id") return done(args.includes("alice") ? state.enrolled ? "60001 60002 60000\n" : "60001 60002\n" : state.session ? "60001 60002 60000\n" : "60001 60002\n");
      if (args[0] === "/usr/bin/stat" && args.includes("--format=%d|%i|%F|%u|%g|%a")) return done("1|500|socket|0|60000|660\n");
      if (args[0] === "docker") {
        if (args[1] === "--version") return done("Docker version29.9.1");
        if (args[1] === "context") return args[2] === "show" ? done("default") : done('{"Host":"unix:///run/docker.sock"}');
        if (args.includes("info")) return state.daemonReady ? done('{"ServerVersion":"29.9.1","OSType":"linux","Architecture":"amd64"}') : done("", 1, "permission denied");
        if (args.includes("compose")) return done("5.6.0");
        if (args.includes("image")) return done("", 1, "No image");
      }
      if (args[0] === "dpkg-query") return done(Object.entries(aptPackages).map(([name, version]) => `${name}\t${version}\tinstalled\tok`).join("\n"));
      if (args[0] === "/usr/bin/dpkg-query" && args.includes("--search")) {
        const path = args.at(-1)!;
        return done(`${path.endsWith("containerd.service") ? "containerd.io" : path.endsWith("/systemctl") ? "systemd" : path.endsWith("/sudo") ? "sudo" : path.endsWith("/usermod") ? "passwd" : "docker-ce"}: ${path}\n`);
      }
      if (args[0] === "/usr/bin/readlink") return done(args.at(-1)!.replace(/^\/lib\//, "/usr/lib/")+"\n");
      if (args[0] === "/usr/bin/stat" && args.includes("--format=%d|%i|%F")) return state.active ? done("1|500|socket\n") : done("", 1, "No such file or directory");
      if (args[0] === "/usr/bin/stat") return done(`regular file|0|${args.at(-1) === "/usr/bin/sudo" ? "4755" : args.at(-1) === "/usr/bin/systemctl" || args.at(-1) === "/usr/sbin/usermod" ? "755" : "644"}|1\n`);
      if (args[0] === "/usr/bin/sha256sum") return done(`${hashes[args.at(-1)!.split("/").at(-1)!]}  ${args.at(-1)}\n`);
      if (args[0] === "/usr/bin/systemctl") {
        if (args.includes("is-active")) return done("active\n");
        if (args.includes("list-units")) return done("docker.socket loaded active listening Docker\n");
        const unit = args.at(-1)!;
        if (!Object.hasOwn(hashes, unit)) throw new Error("Unknown APT fixture unit");
        const active = state.active || (unit === "containerd.service" && state.containerdActive);
        const fields: Record<string, string> = { Id: unit, LoadState: "loaded", ActiveState: active ? "active" : "inactive", SubState: active ? unit.endsWith(".socket") ? "listening" : "running" : "dead", UnitFileState: "disabled", FragmentPath: `/usr/lib/systemd/system/${unit}`, DropInPaths: "", Transient: "no", NeedDaemonReload: "no", Job: "0", Wants: unit === "docker.service" ? "network-online.target containerd.service" : "", Requires: unit === "docker.service" ? "docker.socket sysinit.target system.slice" : unit === "containerd.service" ? "sysinit.target system.slice" : "sysinit.target", Requisite: "", BindsTo: "", Upholds: "", OnSuccess: "", OnFailure: "", CanStart: "yes", RefuseManualStart: "no", Listen: unit === "docker.socket" ? "/run/docker.sock (Stream)" : "", Triggers: unit === "docker.socket" ? "docker.service" : "" };
        const requested = args.find((arg) => arg.startsWith("--property="))?.slice(11).split(",");
        if (!requested || requested.some((key) => !Object.hasOwn(fields, key))) throw new Error("Unknown APT fixture properties");
        return done(requested.map((key) => `${key}=${fields[key]}`).join("\n"));
      }
      if (args[0] === "/usr/bin/sudo") { if (args.includes("/usr/sbin/usermod")) state.enrolled = true; else { state.active = true; state.containerdActive = true; } return done(); }
      throw new Error(`Unexpected APT service fixture operation ${args[0]}`);
    },
  };
  return { root, host, calls, prompts, confirmations, state, handlers: setupCommands(host, [aptProfile]) };
}
