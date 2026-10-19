# Prerequisite diagnosis and setup

Fleur requires Bun 1.4.3 before invocation. Doctor and setup run through Bun and never invoke Node or npm. `doctor --json` returns one version 1 result; failures identify a stable code, exit category and recovery actions. The default operation deadline is 60 seconds. Help and argument validation do not probe Docker, load native libraries, read grants or create setup state.

Doctor distinguishes native architecture and Rosetta, unsupported targets, missing Docker CLI, an effective remote endpoint, daemon access denial, Compose availability and a digest-pinned owned smoke container. It resolves Docker environment/context overrides and freezes the local Unix endpoint for subsequent requests; it never changes global Docker context. Raw Docker stderr, credentials and private machine identity are not returned. Image acquisition is explicit: doctor never pulls a missing image.

A smoke container uses an existing exact architecture-specific Bun image from the compatibility experiments. It has a nonce name and ownership label, no network, read-only root, dropped capabilities, no-new-privileges and resource limits. Its image identity and ownership are checked before use and removal. The deadline reserves time for cleanup. Unconfirmed cleanup returns `RECOVERY_REQUIRED` with exit 5. No database, existing container or volume is modified.

`setup` rechecks actual prerequisites. A compatible observed installation is preserved. A missing smoke image can be acquired only under a matching human setup grant for the exact action, Docker digest-pull method, local endpoint and image, OS user, machine and plan checksum. Interactive confirmation offers `once`, `remember` or `deny`. JSON and piped invocations cannot create or broaden grants; there is no generic yes flag. A once grant is durably consumed before acquisition, including failed downloads. Reruns inspect actual state rather than replaying a checkpoint. Missing authority returns exit 3 promptly. The supported trust boundary does not prevent unrestricted same-user software from editing Fleur or its private grant storage.

Grants live in the OS user's private state directory outside application projects. `setup grants list` inspects them without changing state. `setup grants revoke <id>` atomically revokes a grant without changing installed software. An OS file lock serializes grant changes and image setup actions; it releases on process death. Contention returns `MAINTENANCE_BUSY` with exit 5. Unsafe, malformed or symlinked state is rejected. Grant records require exact primitive field types; array-to-string coercion never grants authority. Both reads and writes enforce at most 100 records and 64 KiB of encoded UTF-8, including the published newline. A new grant that exceeds either bound is refused before publication or acquisition, preserving all existing authority. No records are silently pruned; existing valid grants remain usable while creation requires explicit store recovery. Never delete another process's lock by guessing whether a PID is stale.

See [Docker Desktop application placement](setup-desktop.md) for its separate authority and recovery rules, and [setup artifact evidence](setup-artifact-evidence.md) for verified payload observations and their native-support limits.

## Current evidence and remaining work

Observed CLI, daemon, Compose and smoke readiness do not yet establish a verified native release installation profile. Doctor therefore reports the release profile as unverified and returns exit 4 even after a successful smoke check. This is an explicit implementation limitation, not a passed release gate. Native Docker Desktop installation/readiness and native Debian/Arch Docker installations were not established by the earlier compatibility userspace fixtures.

Assisted package installation remains blocked. Its permitted methods are verified official Docker Desktop on native macOS, Docker's official signed apt repository on Ubuntu 24.04/26.04 and Debian 13 amd64/arm64, and official pacman packages on Arch x86_64. The candidate inventory in `src/setup/installer-candidates.json` records exact available package versions, hashes and sources for research. These payloads/signatures and native installation behavior have not been verified or executed by Fleur. They are never executed by setup. A missing or incompatible profile requires manual action and leaves this acceptance criterion incomplete.

Installation, repository changes, service starting/enabling, Docker access privileges, PATH/configuration and agreement acceptance require separate authority. Package post-install scripts and Desktop installation can have these side effects; an install grant cannot silently cover them. Fleur never removes conflicts, upgrades or replaces existing installations, edits profiles/context, changes Docker permissions or accepts legal terms automatically.

Official method references: [macOS](https://docs.docker.com/desktop/setup/install/mac-install/), [Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Debian](https://docs.docker.com/engine/install/debian/), [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/), and [Arch packages](https://archlinux.org/packages/extra/x86_64/docker/). Mutable upstream documentation and package availability do not replace native release verification.

### Native apt adapter checkpoint

The compiled native profile catalog remains empty until release verification admits
an exact platform row. Candidate metadata cannot authorize execution. The apt
adapter handles the compatible missing subset of an exact package set against
the exact official Docker repository. Fully configured exact versions with a
normal dpkg error flag are preserved. Wrong versions, half-configured packages,
reinstallation-required flags and unknown package state stop without package
changes. An existing usable CLI that is not accounted for by the exact configured
`docker-ce-cli` package is preserved rather than replaced. A rejected remote or
malformed Docker endpoint does not enter native package planning. Inventory queries explicitly target `/` and `/var/lib/dpkg`, so
`DPKG_ROOT` and `DPKG_ADMINDIR` cannot redirect the inventory away from the host
that the installation targets. Repository creation has a separate scoped adapter. Desktop and Arch installation
remain unfinished.

A verified apt plan requires separate installation, configuration, Docker access,
service start and service enable grants because authenticated maintainer scripts
can perform these actions during package installation. All permissions bind the
same immutable profile checksum, OS user and machine. Once permissions are
consumed durably together before the single package-manager mutation. The setup
lock serializes that bounded mutation; grant revocation can report busy while it
is running. No automatic license acceptance or interactive sudo prompt occurs.

Before installation the adapter checks exact Docker repository configuration and
the authenticated public key bytes, then simulates exact pinned packages with upgrades and removals
forbidden. Unexpected dependency changes fail closed. Actual installation uses
noninteractive OS authentication and the same restricted repository selection.
A successful package command still requires exact installed-state verification;
it does not claim daemon, access or smoke readiness. A later invocation probes
actual package state rather than repeating an installation from a checkpoint.
The public `packageState` diagnostic names configured and missing packages.
Simulation and installation request only the missing names at their exact
versions. Setup checks state again before installation and re-probes the complete
set afterward; a retry does not repeat already completed package actions.

Disposable command fixtures exercise this path without installing Docker or
changing services on the developer machine. They are not native installation
proof.

Repository configuration requires its own `repository-configuration` grant,
separate from the package maintainer scripts' `configuration` grant. It permits
only fixed official key/source files, their required directories and a source
scoped index refresh. Root-owned regular files and safe root directory metadata
are checked before reuse. Differing files are preserved. New files use private
staging, create-only publication and exact metadata/byte readback; a skipped copy
or racing file cannot count as success. A failed index refresh preserves completed
configuration and leaves package installation authority unused. No rollback
removes successful shared system configuration automatically.

Official apt signatures and package payloads, Arch package signatures and Docker
Desktop disk image identities have been authenticated during development. This
artifact evidence does not establish native installation or runtime support. The
compiled native profile catalog is still disabled; disposable command fixtures
exercise the adapters without changing host software.
