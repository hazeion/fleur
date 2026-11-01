import metadata from "../../package.json" with { type: "json" };
export const releaseVersion = metadata.version;
/** The Bun version floor this release declares in `engines.bun`, stored as `>=X.Y.Z`. Bun and npm ignore it; the CLI gate reads it. */
export const bunFloor: string = metadata.engines.bun;
export type BunAdmission = { readonly admitted: true } | { readonly admitted: false; readonly reason: "below-floor" | "invalid-floor" | "unparseable-version" };
const floorForm = /^>=(\d+)\.(\d+)\.(\d+)$/;
const versionForm = /^(\d+)\.(\d+)\.(\d+)$/;
/**
 * Admits a Bun version at or above the floor, comparing major, minor and patch numerically.
 * The stored floor is validated first: `Bun.semver.satisfies` admits everything for an unparseable range,
 * so an invalid floor refuses instead. `Bun.version` is plain X.Y.Z even on canary builds; pre-release detection belongs to doctor.
 */
export function bunAdmission(version: string, floor: string = bunFloor): BunAdmission {
  const required = floorForm.exec(floor);
  if (!required) return { admitted: false, reason: "invalid-floor" };
  const actual = versionForm.exec(version);
  if (!actual) return { admitted: false, reason: "unparseable-version" };
  for (let index = 1; index <= 3; index++) {
    const difference = Number(actual[index]) - Number(required[index]);
    if (difference !== 0) return difference > 0 ? { admitted: true } : { admitted: false, reason: "below-floor" };
  }
  return { admitted: true };
}
