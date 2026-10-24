# Internal native installation candidate artifact

This developer-only builder prepares a separately identified internal installation candidate for an owned Ubuntu 24.04, Ubuntu 26.04 or Debian 13 amd64 guest. The default target remains Ubuntu 24.04. Selection does not establish native support or alter the ordinary production catalog.

```sh
bun scripts/build-native-candidate.ts --out "$FLEUR_INTERNAL_ARTIFACTS"
# Optional fixed target: --fixture ubuntu26-amd64 or --fixture debian13-amd64
```

The builder uses the selected Bun runtime to decode its owned gzip archive before invoking absolute `/usr/bin/tar` on uncompressed bytes. It does not resolve a gzip executable through the caller PATH or require Node.

The output directory must be new and outside the source repository; its existing parent is resolved before this check. The builder refuses existing paths and accepts no profile or catalog argument. It opens the approved parent without following a final symlink, validates its descriptor identity against the ancestor inventory, then creates and opens the fixed output basename relative to that descriptor. Replacing an ancestor with a symlink does not redirect initial creation through that symlink. Existing unknown nodes are never overwritten or removed. It retains the newly created output directory descriptor and checks directory/ancestor identities before and after publication. Publication uses exclusive descriptor-relative hard links and no-follow descriptor readback; staging and output must share a filesystem. If needed, choose an owned `TMPDIR` on the output filesystem. Cross-filesystem publication fails instead of falling back to path-based writes. Changed output paths are left untouched; failed builds may retain files in their original owned directory for inspection and never report success for a replacement. It performs no download, package installation, grant creation, key import, service action or VM launch. Packing ignores package lifecycle scripts. The caller gets:

- `fleur-ordinary.tgz`: the actual ordinary packed source, unchanged.
- `fleur-internal-native-candidate.tgz`: a private package with an internal name and marker.
- `build-evidence.json`: SHA256 values for both archives, the source-owned catalog, and every file from the ordinary source archive.

These hashes describe the actual packed bytes, including an explicitly changed working-tree source snapshot; a Git commit identifier is not substituted for byte evidence. The builder stages a copy of the ordinary archive. It modifies only the internal copy's entry and package metadata and adds the internal catalog/marker. All `src/` helper code remains byte-identical. An unexpected handler-construction anchor stops the build rather than guessing how to patch the entry.

The internal entry uses the existing CLI parsing, launcher, command registry, `runCli`, setup grants, production host and installer adapters. Its catalog input is the selected fixed source-owned [Ubuntu 24](../scripts/native-candidate-ubuntu24-amd64.json), [Ubuntu 26](../scripts/native-candidate-ubuntu26-amd64.json) or [Debian 13](../scripts/native-candidate-debian13-amd64.json) record. Its bytes must match the builder's reviewed SHA256. The generated profile, package map and frozen artifact records are immutable. Its catalog hash also participates in the legacy profile checksum used for authority. The builder accepts only its closed fixture choices. The produced internal CLI has no runtime flag, environment variable or project file that can replace its compiled candidate. Every internal invocation writes a fixed `INTERNAL NATIVE CANDIDATE` disclosure to stderr; normal version 1 JSON stays on stdout.

## Authentication is not native support

The catalog freezes previously authenticated Docker repository key, signed InRelease/index and exact downloaded package hash/size records for the selected exact distribution and architecture. The builder pins that reviewed record; it does not download payloads or repeat their authentication. The record links exact official payload URLs and retains the observed authentication date. The legacy `verified: true` profile field means compiled internal catalog admission only. Both metadata and stderr explicitly report installation evidence pending and runtime support unverified. The ordinary archive receives no candidate profile or experimental option.

The APT adapter acquires exact packages through the normal signed repository method into owned private staging and compares actual streamed size/SHA256 and control metadata with the compiled frozen artifact records. It installs verified local archives with downloads disabled and a standard protocol-v2 guard that rehashes the actual dpkg archive inputs and rejects extra actions or unrelated pending package work. These are fixture-verified code gates, not native installation evidence. Authenticated transitive dependency closure, actual backend/hook behavior and guest-selected package evidence remain required before any ordinary production catalog activation. A pristine guest may need dependencies outside the current five-package plan; refusal is a real failed prerequisite, not permission to install an unreviewed closure or preseed success.

## Next execution boundary

The [artifact evidence](setup-artifact-evidence.md) records the actual Ubuntu installation observations and the retained Debian image input. Debian boot, installation and runtime evidence remain pending. Each new target still requires authenticated image bytes and structural checks, an owned overlay and seed, loopback-only authenticated SSH, original protected guest custody, and actual package-manager, systemd, Docker and packed CLI results. Existing resources and complete cleanup must be verified. This builder launches no VM and supplies no simulated human grant state.
