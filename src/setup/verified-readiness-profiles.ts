import type { VerifiedReadinessProfile } from "./readiness.ts";

/** Exact Ubuntu prerequisite qualification; broader platform support is not implied. */
export const verifiedReadinessProfiles = [{
  id: "ubuntu-24.04-x64-docker-29.9.1",
  host: { system: "linux", distribution: "ubuntu", release: "24.04", architecture: "x64" },
  bun: "1.4.3",
  cli: { version: "29.9.1", commit: "dfc520d" },
  engine: {
    version: "29.9.1", commit: "b26fb77", kernel: "6.8.0-147-generic",
    platform: "Docker Engine - Community", cgroupDriver: "systemd", cgroupVersion: "2",
    operatingMode: "rootful", securityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
  },
  containerd: { version: "v2.4.2", commit: "b7a25261e029d68978bbf290df0a62fc819b3c51" },
  runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" },
  compose: "5.6.0",
  image: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e",
  evidence: {
    readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2",
    isolationSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2",
  },
}] as const satisfies readonly VerifiedReadinessProfile[];
