// CI prerequisite for the public development lifecycle tests: the digest-pinned
// smoke image for this architecture and the pinned PostgreSQL image must exist
// locally, because `fleur dev` reports missing images instead of pulling them.
// The native controller and worker bases are pulled too: otherwise BuildKit
// fetches them from the registry inside development start's build budget (#182).
// Developers acquire the same images through `fleur setup`; this script is for
// disposable runners only and never changes a readiness profile.
import { smokeImages } from "../src/setup/profiles.ts";
import { developmentPostgresImage } from "../src/runtime/development/postgres.ts";
import { nativeBaseImages } from "../src/runtime/native/build.ts";

/** Every image a development start on this `process.arch` needs locally, or null for an unpinned architecture. */
export function pinnedDevelopmentImages(architecture: string): string[] | null {
  const smoke = smokeImages[architecture];
  const native = Object.hasOwn(nativeBaseImages, architecture) ? nativeBaseImages[architecture as keyof typeof nativeBaseImages] : undefined;
  if (!smoke || !native) return null;
  return [...new Set([smoke, native.controller, native.worker, developmentPostgresImage])];
}

if (import.meta.main) {
  const images = pinnedDevelopmentImages(process.arch);
  if (!images) { console.error(`No pinned development images for ${process.arch}`); process.exit(1); }
  for (const image of images) {
    const child = Bun.spawn(["docker", "pull", "--quiet", image], { stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) { console.error(`docker pull failed for ${image}`); process.exit(1); }
  }
}
