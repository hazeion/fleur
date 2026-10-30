// CI prerequisite for the public development lifecycle tests: the digest-pinned
// smoke image for this architecture and the pinned PostgreSQL image must exist
// locally, because `fleur dev` reports missing images instead of pulling them.
// Developers acquire the same images through `fleur setup`; this script is for
// disposable runners only and never changes a readiness profile.
import { smokeImages } from "../src/setup/profiles.ts";
import { developmentPostgresImage } from "../src/runtime/development/postgres.ts";

const smoke = smokeImages[process.arch];
if (!smoke) { console.error(`No pinned smoke image for ${process.arch}`); process.exit(1); }
for (const image of [smoke, developmentPostgresImage]) {
  const child = Bun.spawn(["docker", "pull", "--quiet", image], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) { console.error(`docker pull failed for ${image}`); process.exit(1); }
}
