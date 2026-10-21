/** Exact compatibility-experiment base images; this is not native installation proof. */
export const smokeImages: Readonly<Record<string, string>> = {
  x64: "oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e",
  arm64: "oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023",
};

import type { HostIdentity } from "./commands.ts";
export function installationMethod(identity: HostIdentity): string | null {
  if (!["x64", "arm64"].includes(identity.architecture)) return null;
  if (identity.system === "darwin" && /^\d+\./.test(identity.release) && Number(identity.release.split(".")[0]) >= 13) return "docker-desktop-official-dmg";
  if (identity.system !== "linux") return null;
  if ((identity.distribution === "ubuntu" && ["24.04", "26.04"].includes(identity.release)) || (identity.distribution === "debian" && identity.release === "13")) return "docker-official-apt";
  return identity.distribution === "arch" && identity.architecture === "x64" ? "arch-official-pacman" : null;
}
