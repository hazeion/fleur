import type { VerifiedReadinessProfile } from "./readiness.ts";

/** Exact measured Ubuntu readiness tuples; installation qualification is separate. */
export const verifiedReadinessProfiles = [{
  id: "ubuntu-24.04-x64-docker-29.9.1",
  host: { system: "linux", distribution: "ubuntu", release: "24.04", architecture: "x64" },
  bun: "1.4.3",
  cli: { version: "29.9.1", commit: "dfc520d" },
  // This Engine build reports its default AppArmor template as profile=default.
  engine: {
    version: "29.9.1", commit: "b26fb77", kernel: "6.8.0-147-generic",
    platform: "Docker Engine - Community", cgroupDriver: "systemd", cgroupVersion: "2",
    operatingMode: "rootful", securityOptions: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"],
  },
  containerd: { version: "v2.4.2", commit: "b7a25261e029d68978bbf290df0a62fc819b3c51" },
  runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" },
  compose: "5.6.0",
  image: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e",
  evidence: {
    readinessSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2",
    isolationSha256: "75bf58a1f8b510eb1e90dcf48a93814b7e8b86d18cd977926784535429e775a2",
  },
}, {
  id: "ubuntu-26.04-x64-docker-29.9.1",
  host: { system: "linux", distribution: "ubuntu", release: "26.04", architecture: "x64" },
  bun: "1.4.3",
  cli: { version: "29.9.1", commit: "dfc520d" },
  engine: {
    version: "29.9.1", commit: "b26fb77", kernel: "7.0.0-38-generic",
    platform: "Docker Engine - Community", cgroupDriver: "systemd", cgroupVersion: "2",
    operatingMode: "rootful", securityOptions: ["name=apparmor,profile=default", "name=seccomp,profile=builtin", "name=cgroupns"],
  },
  containerd: { version: "v2.4.2", commit: "b7a25261e029d68978bbf290df0a62fc819b3c51" },
  runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" },
  compose: "5.6.0",
  image: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e",
  evidence: {
    readinessSha256: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07",
    isolationSha256: "5874bec578a422cdc49177d2d69e75a69c3aa859a0c42f351c7d6c972eaf8d07",
  },
}, {
  id: "ubuntu-24.04-arm64-docker-28.0.4-azure",
  host: { system: "linux", distribution: "ubuntu", release: "24.04", architecture: "arm64" },
  bun: "1.4.3",
  cli: { version: "28.0.4", commit: "b8034c0" },
  engine: {
    version: "28.0.4", commit: "6430e49", kernel: "6.17.0-1022-azure",
    platform: "Docker Engine - Community", cgroupDriver: "systemd", cgroupVersion: "2",
    operatingMode: "rootful", securityOptions: ["name=apparmor", "name=cgroupns", "name=seccomp,profile=builtin"],
  },
  containerd: { version: "v2.4.1", commit: "f2551031d7276a770f65f98c9b52e57e7dad07e8" },
  runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" },
  compose: "2.38.2",
  image: "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023",
  evidence: {
    readinessSha256: "15db2e603e2cdfccd8549aa78bcc7a1bf53a22f962012449297460608d0332e9",
    isolationSha256: "17e7c7a80b9bff706368f2d19ac52538a20bee6725abaf902ab97220d33c7c48",
  },
}, {
  id: "ubuntu-24.04-x64-docker-28.0.4-azure",
  host: { system: "linux", distribution: "ubuntu", release: "24.04", architecture: "x64" },
  bun: "1.4.3",
  cli: { version: "28.0.4", commit: "b8034c0" },
  engine: {
    version: "28.0.4", commit: "6430e49", kernel: "6.17.0-1022-azure",
    platform: "Docker Engine - Community", cgroupDriver: "systemd", cgroupVersion: "2",
    operatingMode: "rootful", securityOptions: ["name=apparmor", "name=cgroupns", "name=seccomp,profile=builtin"],
  },
  containerd: { version: "v2.4.1", commit: "f2551031d7276a770f65f98c9b52e57e7dad07e8" },
  runc: { version: "1.5.2", commit: "v1.5.2-0-g29dd3dc2" },
  compose: "2.38.2",
  image: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e",
  evidence: {
    readinessSha256: "2c29e92c1eba819c44f33361b8ac5ba319ae9343dc9cba4e64973b304774c7fd",
    isolationSha256: "a3f687541d7438b370b8c2dcbf74d2cf8c2b7a248f385257b68d31c72eba9402",
  },
}] as const satisfies readonly VerifiedReadinessProfile[];
