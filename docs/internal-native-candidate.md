# Internal native installation candidate artifact

This developer-only builder prepares one separately identified installation candidate for a future owned Ubuntu 24.04 amd64 guest. It is not a published Fleur release, a supported native profile, or a completed installation proof. The ordinary production catalog stays empty.

```sh
bun scripts/build-native-candidate.ts --out "$FLEUR_INTERNAL_ARTIFACTS"
```

The output directory must be new and outside the source repository; its existing parent is resolved before this check. The builder refuses existing paths and accepts no profile or catalog argument. It retains the newly created output directory descriptor and checks directory/ancestor identities before and after publication. Publication uses exclusive descriptor-relative hard links and no-follow descriptor readback; staging and output must share a filesystem. If needed, choose an owned `TMPDIR` on the output filesystem. Cross-filesystem publication fails instead of falling back to path-based writes. Changed output paths are left untouched; failed builds may retain files in their original owned directory for inspection and never report success for a replacement. It performs no download, package installation, grant creation, key import, service action or VM launch. Packing ignores package lifecycle scripts. The caller gets:

- `fleur-ordinary.tgz`: the actual ordinary packed source, unchanged.
- `fleur-internal-native-candidate.tgz`: a private package with an internal name and marker.
- `build-evidence.json`: SHA256 values for both archives, the source-owned catalog, and every file from the ordinary source archive.

These hashes describe the actual packed bytes, including an explicitly changed working-tree source snapshot; a Git commit identifier is not substituted for byte evidence. The builder stages a copy of the ordinary archive. It modifies only the internal copy's entry and package metadata and adds the internal catalog/marker. All `src/` helper code remains byte-identical. An unexpected handler-construction anchor stops the build rather than guessing how to patch the entry.

The internal entry uses the existing CLI parsing, launcher, command registry, `runCli`, setup grants, production host and installer adapters. Its only catalog input is the fixed source-owned [Ubuntu candidate](../scripts/native-candidate-ubuntu24-amd64.json), whose bytes must match the builder's reviewed SHA256. The generated profile and package map are frozen. Its catalog hash also participates in the legacy profile checksum used for authority. No CLI flag, environment variable or project file can select another candidate. Every internal invocation writes a fixed `INTERNAL NATIVE CANDIDATE` disclosure to stderr; normal version 1 JSON stays on stdout.

## Authentication is not native support

The catalog freezes previously authenticated Docker repository key, signed InRelease/index and exact downloaded package hash/size records for Ubuntu 24.04 amd64. The builder pins that reviewed record; it does not download payloads or repeat their authentication. The record links exact official payload URLs and retains the observed authentication date. The legacy `verified: true` profile field means compiled internal catalog admission only. Both metadata and stderr explicitly report installation evidence pending and runtime support unverified. The ordinary archive receives no candidate profile or experimental option.

The existing apt adapter enforces exact package names/versions and repository trust/configuration. This builder does not add direct runtime comparison of downloaded payloads with the frozen package hashes. That enforcement, authenticated transitive dependency closure and actual guest-selected package evidence remain required before any ordinary production catalog activation. A pristine guest may need dependencies outside the current five-package plan; refusal is a real failed prerequisite, not permission to install an unreviewed closure or preseed success.

## Next execution boundary

No fresh installation has been executed by this slice. The future VM harness still needs ordinary GPG verification of the dated Canonical checksum signature and trusted fingerprint; actual image hashing and full `qemu-img` structural/backing-chain validation; an owned disposable overlay and seed; loopback-only authenticated SSH; and real package-manager, systemd, Docker and packed CLI evidence. It must preserve existing resources and report cleanup outcomes. Artifact-specific research authentication or header inspection alone cannot stand in for those execution checks. This builder launches no VM and supplies no simulated human grant state.
