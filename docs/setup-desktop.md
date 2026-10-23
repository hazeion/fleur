# Docker Desktop application placement

Desktop setup is under development. The ordinary release has no admitted Desktop installation profile yet. Authenticated downloads are evidence of artifact integrity; they do not establish native installation or Fleur runtime support. See [artifact evidence](setup-artifact-evidence.md).

The adapter accepts only an immutable, source-owned official DMG profile for the exact native architecture and macOS release. The internal test seam can supply host fixtures; no CLI option, project file or environment variable can select a profile or mark it supported.

For an admitted candidate, `fleur setup` requests separate scoped acquisition and installation grants. It checks the exact payload size and SHA256, Apple/Docker signing identity and notarization, mounted application signature, version and architecture. It mounts only its own read-only image, copies the app into a private stage on the destination volume, and publishes with atomic no-replacement semantics. Existing applications are preserved, including ones appearing concurrently. An observed staged-application replacement is preserved for recovery and never published. If copying fails before a child identity is recorded, a nonempty stage is preserved for recovery; only its verified empty directory may be removed. Uncertain post-publication identity or durability returns recovery-required status rather than a completed placement claim. Setup uses the invoking user's existing filesystem authority; an unwritable application directory requires human action rather than an automatic privileged copy.

Application placement does not start Docker Desktop, run its installer, accept its agreement, install privileged helpers, configure CLI paths or grant Docker access. Those remain separate actions. Successful placement returns a resumable human-action result until the operator completes the actual agreement and any separately authorized start/configuration steps. `fleur doctor` must then inspect real daemon, Compose and owned smoke readiness. No result from placement promotes native support.

Every external operation and image-hash loop shares the command deadline, reserving time for owned image cleanup. Cleanup checks the recorded image path, mountpoint and device identity before normal detachment. Unknown ownership or a busy image produces recovery-required status; setup never forces unmounts or removes unrelated resources. Once grants are consumed durably before acquisition and cannot replay after a failed attempt.

The Desktop fixture tests execute real temporary filesystem placement: Darwin uses `renameatx_np(RENAME_EXCL)` and Linux uses `renameat2(RENAME_NOREPLACE)`. Download, signing tools, mounts and copying are simulated at the approved host boundary. These tests do not install Docker, launch its app or prove native Desktop readiness. Native macOS Intel and Apple Silicon installation, agreement and daemon/runtime verification remain open requirements.


## Verify an existing Desktop installation

For development verification on a personal native macOS host, finish Docker Desktop's own startup and human prompts, then run `fleur doctor`. If its pinned smoke image is absent, use interactive `fleur setup` to inspect and expressly authorize that exact acquisition. Doctor never downloads it implicitly.

After acquisition, run `FLEUR_EXISTING_DOCKER_ONLY=yes FLEUR_NATIVE_REPORT=<private-report-path> bun scripts/verify-native-setup.ts` from the source checkout. This mode requires an existing local endpoint and image, runs the packed CLI twice, preserves context and container inventory, and removes only its independently verified owned sentinel. It performs no image pull, package installation, app startup, permission or configuration change. Its report records the verifier hash and observed readiness, while leaving installation, release-profile and human-consent proof false. The invoking verification supervisor must bind the actual source commit; this command cannot admit a release profile.

The older `FLEUR_OWNED_DISPOSABLE_HOST=yes` Linux CI mode retains its explicit pinned-image acquisition. Do not label a personal Mac disposable to invoke that path.
