import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { setupCommands, type HostCommandResult, type SetupHost } from "../../../src/setup/commands.ts";
const packages = {
  docker: { version: "1:29.9.0-1", url: "https://archive.archlinux.org/packages/d/docker/docker-1:29.9.0-1-x86_64.pkg.tar.zst", sha256: "3cc00845b632f3302fe148b939c2736a094599d42e885aab214a5a532bd87d54", size: 50000000, signature: "c2lnbmF0dXJl", signer: "2E36D8620221482FC45CB7F2A91764759326B440" },
  "docker-compose": { version: "5.6.0-1", url: "https://archive.archlinux.org/packages/d/docker-compose/docker-compose-5.6.0-1-x86_64.pkg.tar.zst", sha256: "152ccc5e901b5a9ea2d53e29b8ad7b8ec736c9da75bbd224dc472a407578690d", size: 50000000, signature: "c2lnbmF0dXJl", signer: "601F20F1D1BBBF4A78CF5B6DF6B1610B3ECDBC9F" },
  containerd: { version: "2.4.1-1", url: "https://archive.archlinux.org/packages/c/containerd/containerd-2.4.1-1-x86_64.pkg.tar.zst", sha256: "c352b4c019c3d527daa50517a6420a7672b01876b95b80d72dd7192f05220999", size: 50000000, signature: "c2lnbmF0dXJl", signer: "262A58EC6C51F7EA395B2E2DFDC3040B92ACA748" },
  runc: { version: "1.5.2-1", url: "https://archive.archlinux.org/packages/r/runc/runc-1.5.2-1-x86_64.pkg.tar.zst", sha256: "b204e74bba04c491d0bd71f8b5adefff538bbfc516d199bdb1a1513959977dd3", size: 50000000, signature: "c2lnbmF0dXJl", signer: "05C7775A9E8B977407FE08E69D4C5AA15426DA0A" },
};
const profile = { method: "arch-official-pacman" as const, verified: true as const, distribution: "arch" as const, release: "rolling" as const, architecture: "x64" as const, snapshot: "2026-10-12" as const, packages };

const unitHashes: Record<string, string> = {
  "docker.service": "a12d90fd03761bf79659a185c4a2c40e08934d7ada9e05130e64bd5eb4d634aa",
  "docker.socket": "96cd0d89474816ddfb03893b44c36e7d744254aed1bf6d30eca65ff396114656",
  "containerd.service": "7522a4e33c633f22fc0049d3c075b552f7df30cd978acd0175b972bdebc922ea",
};
export async function archAccessFixture() {
  const root = await mkdtemp("/tmp/fleur-arch-service-");
  const calls: string[][] = [];
  const prompts: string[] = [];
  const confirmations: { action: string; target: string }[] = [];
  const state = { active: true, socketListening: true, manualDaemon: false, upholds: "", packageDrift: false, enrolled: true, session: false, daemonReady: false };
  const done = (stdout = "", exitCode = 0, stderr = ""): HostCommandResult => ({ status: "completed", stdout, exitCode, stderr });
  const host: SetupHost = {
    stateDirectory: join(root, "state"), interactive: true,
    confirmHuman: async (plan) => { confirmations.push(plan); prompts.push(plan.action); return "once"; },
    host: async () => ({ system: "linux", architecture: "x64", translated: false, release: "rolling", distribution: "arch", machineId: "a".repeat(64) }),
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "/usr/bin/getent") return args.includes("passwd") ? done(`alice:x:${process.getuid!()}:60001:Alice:/home/alice:/bin/bash\n`) : done(`docker:x:60000:${state.enrolled ? "bob,alice" : "bob"}\n`);
      if (args[0] === "/usr/bin/id") return done(args.includes("alice") ? state.enrolled ? "60001 60002 60000\n" : "60001 60002\n" : state.session ? "60001 60002 60000\n" : "60001 60002\n");
      if (args[0] === "/usr/bin/stat" && args.includes("--format=%d|%i|%F|%u|%g|%a")) return done("1|500|socket|0|60000|660\n");
      if (args[0] === "/usr/bin/pacman" && args.includes("--database")) return done();
      if (args[0] === "/usr/bin/stat" && args.at(-1) === "/var/lib/pacman/db.lck") return done("", 1, "No such file or directory");
      if (args[0] === "docker") {
        if (args[1] === "--version") return done("Docker version29.9.0");
        if (args[1] === "context") return args[2] === "show" ? done("default\n") : done('{"Host":"unix:///run/docker.sock"}');
        if (args.includes("compose")) return done("5.6.0\n");
        if (args.includes("info")) return state.daemonReady ? done('{"ServerVersion":"29.9.0","OSType":"linux","Architecture":"amd64"}') : done("", 1, "permission denied");
        if (args.includes("image")) return done("", 1, "No image");
      }
      if (args[0] === "pacman") return args.includes("--query") ? done(Object.entries(packages).map(([name, value]) => `${name} ${value.version}\n`).join("")) : done();
      if (args[0] === "stat" && args.at(-1) === "/var/lib/pacman/db.lck") return done("", 1, "No such file or directory");
      if (args[0] === "/usr/bin/stat" && args.includes("--format=%d|%i|%F")) {
        const path = args.at(-1)!;
        if (path === "/run/unrelated.sock") return done("1|600|socket\n");
        if (path === "/run/docker.sock") return state.active || state.socketListening || state.manualDaemon ? done("1|500|socket\n") : done("", 1, "No such file or directory");
        throw new Error("Unexpected passive socket path");
      }
      if (args[0] === "/usr/bin/stat") return done(`regular file|0|${args.at(-1) === "/usr/bin/sudo" ? "4755" : args.at(-1)?.startsWith("/usr/bin/") ? "755" : "644"}|1\n`);
      if (args[0] === "/usr/bin/sha256sum") { const path = args.at(-1)!; return done(`${unitHashes[path.split("/").at(-1)!]}  ${path}\n`); }
      if (args[0] === "/usr/bin/pacman" && !args.includes("--owns")) return done(Object.entries(packages).map(([name, value]) => `${name} ${name === "docker" && state.packageDrift ? "0.1.0" : value.version}`).join("\n"));
      if (args[0] === "/usr/bin/pacman") return done(args.at(-1)?.includes("containerd") ? "containerd\n" : args.at(-1) === "/usr/bin/systemctl" ? "systemd\n" : args.at(-1) === "/usr/bin/sudo" ? "sudo\n" : args.at(-1) === "/usr/bin/usermod" ? "shadow\n" : "docker\n");
      if (args[0] === "/usr/bin/systemctl") {
        if (args.includes("is-active")) return done("active\n");
        if (args.includes("list-units")) return done("docker.socket loaded inactive dead Docker\nunrelated.socket loaded active listening Unrelated\n");
        const unit = args.find((arg) => Object.hasOwn(unitHashes, arg) || ["unrelated.socket", "unrelated.service"].includes(arg));
        if (!unit) throw new Error("Unknown fixture unit");
        const active = unit.startsWith("unrelated.") || state.active || (unit === "docker.socket" && state.socketListening);
        const values: Record<string, string> = { Id: unit, Upholds: unit === "docker.service" ? state.upholds : "", Requisite: "", BindsTo: "", OnSuccess: "", OnFailure: "", CanStart: "yes", RefuseManualStart: "no", LoadState: "loaded", ActiveState: active ? "active" : "inactive", SubState: active ? unit.endsWith(".socket") ? "listening" : "running" : "dead", UnitFileState: "disabled", FragmentPath: `/usr/lib/systemd/system/${unit}`, DropInPaths: "", Transient: "no", NeedDaemonReload: "no", Job: "0", Wants: unit === "docker.service" ? "network-online.target containerd.service" : "", Requires: unit === "docker.service" ? "docker.socket sysinit.target system.slice" : unit === "containerd.service" ? "sysinit.target system.slice" : "sysinit.target", Listen: unit === "docker.socket" ? "/run/docker.sock (Stream)" : unit === "unrelated.socket" ? "/run/unrelated.sock (Stream)" : "", Triggers: unit === "docker.socket" ? "docker.service" : unit === "unrelated.socket" ? "unrelated.service" : "" };
        const requested = args.find((arg) => arg.startsWith("--property="))?.slice(11).split(",");
        return done(Object.entries(values).filter(([key]) => !requested || requested.includes(key)).map(([key, value]) => `${key}=${value}`).join("\n"));
      }
      if (args[0] === "/usr/bin/sudo") { if (args.includes("/usr/bin/usermod")) state.enrolled = true; else state.active = true; return done(); }
      throw new Error(`Unexpected service fixture operation ${args[0]}`);
    },
  };
  return { root, calls, prompts, confirmations, state, host, handlers: setupCommands(host, [profile]) };
}
