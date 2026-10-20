# Prerequisite diagnosis and setup

Fleur requires Bun 1.4.3 before invocation. Doctor and setup run through Bun and never invoke Node or npm. `doctor --json` returns one version 1 result; failures identify a stable code, exit category and recovery actions. The default operation deadline is 60 seconds. Help and argument validation do not probe Docker, load native libraries, read grants or create setup state.

Doctor distinguishes native architecture and Rosetta, unsupported targets, missing Docker CLI, an effective remote endpoint, daemon access denial, Compose availability and a digest-pinned owned smoke container. It resolves Docker environment/context overrides and freezes the local Unix endpoint for subsequent requests; it never changes global Docker context. Raw Docker stderr, credentials and private machine identity are not returned. Image acquisition is explicit: doctor never pulls a missing image.

A smoke container uses an existing exact architecture-specific Bun image from the compatibility experiments. It has a nonce name and ownership label, no network, read-only root, dropped capabilities, no-new-privileges and resource limits. Its image identity and ownership are checked before use and removal. The deadline reserves time for cleanup. Unconfirmed cleanup returns `RECOVERY_REQUIRED` with exit 5. No database, existing container or volume is modified.

`setup` rechecks actual prerequisites. A compatible observed installation is preserved. A missing smoke image can be acquired only under a matching human setup grant for the exact action, Docker digest-pull method, local endpoint and image, OS user, machine and plan checksum. Interactive confirmation offers `once`, `remember` or `deny`. JSON and piped invocations cannot create or broaden grants; there is no generic yes flag. A once grant is durably consumed before acquisition, including failed downloads. Reruns inspect actual state rather than replaying a checkpoint. Missing authority returns exit 3 promptly. The supported trust boundary does not prevent unrestricted same-user software from editing Fleur or its private grant storage.

Grants live in the OS user's private state directory outside application projects. `setup grants list` inspects them without changing state. `setup grants revoke <id>` atomically revokes a grant without changing installed software. An OS file lock serializes grant changes and image setup actions; it releases on process death. Contention returns `MAINTENANCE_BUSY` with exit 5. Unsafe, malformed or symlinked state is rejected. Grant records require exact primitive field types; array-to-string coercion never grants authority. Both reads and writes enforce at most 100 records and 64 KiB of encoded UTF-8, including the published newline. A new grant that exceeds either bound is refused before publication or acquisition, preserving all existing authority. No records are silently pruned; existing valid grants remain usable while creation requires explicit store recovery. Never delete another process's lock by guessing whether a PID is stale.

See [Docker Desktop application placement](setup-desktop.md) for its separate authority and recovery rules, and [setup artifact evidence](setup-artifact-evidence.md) for verified payload observations and their native-support limits.

## Current evidence and remaining work

Observed CLI, daemon, Compose and smoke readiness do not yet establish a verified native release installation profile. Doctor therefore reports the release profile as unverified and returns exit 4 even after a successful smoke check. This is an explicit implementation limitation, not a passed release gate. Native Docker Desktop installation/readiness and native Debian/Arch Docker installations were not established by the earlier compatibility userspace fixtures.

Assisted package installation remains blocked. Its permitted methods are verified official Docker Desktop on native macOS, Docker's official signed apt repository on Ubuntu 24.04/26.04 and Debian 13 amd64/arm64, and official pacman packages on Arch x86_64. The candidate inventory in `src/setup/installer-candidates.json` records exact available package versions, hashes and sources for research. Artifact authentication has been researched separately, as recorded in the artifact evidence document. Native installation behavior remains unverified. The ordinary release catalog is empty, so setup does not execute these research candidates. A missing or incompatible profile requires manual action and leaves this acceptance criterion incomplete.

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

### Arch adapter checkpoint

The disabled native catalog also has an executable Arch x86_64 adapter for the
exact authenticated October 12, 2026 package inventory. Installation,
configuration hooks and system Docker group creation require separate scoped
grants. Installing packages does not authorize starting/enabling services or
adding a user to the Docker group. Service startup has its own scoped action;
Arch user enrollment uses the separate ordinary-user access flow described below.

The adapter preserves exact existing packages and downloads only missing pinned
archives into private staging. It checks size, digest, exact signer and current
keyring trust. Preverification disables ambient GPG options and automatic key
retrieval. A private configuration strengthens local signatures to Required and
TrustedOnly, preserves the effective root/database/keyring/hooks, and registers
no sync repositories. Global configuration, mirrorlists and keyrings are not
reconfigured. Unreviewed dependencies, custom hooks or conflicting package state
fail closed.

The reviewed backend is exactly Pacman 7.1.0 with libalpm 16.0.0. Its source-defined
question policy denies automatic key imports, replacement, ignored-package
installation and corrupt-file deletion, retaining existing negative answers for
conflict removals. A release-owned PreTransaction guard checks every transaction
target and rechecks package state under ALPM's normal lock before installation.
Fixture tests execute the generated guard; native ALPM, hook and installation
proof remains pending. The production catalog is not enabled by these tests.

An unconfirmed privileged transaction retains private installer data and reports
recovery. Further setup cannot create new grants while that transaction remains
indeterminate. Native verification must still establish privileged child cleanup
before this adapter can be admitted as supported.

### Frozen APT payload gate

A source-owned APT profile now requires exact artifact URL, package/version,
Debian architecture, size and SHA256 records. Normal signed-repository resolution
must match the frozen URI and size. Unprivileged `apt-get download` writes only to
owned private operation directories; streamed digest and `dpkg-deb` control checks
must match before any privileged package action. A displayed MD5 is not treated
as payload authentication.

The installation once grant is consumed durably before acquisition. Its exact
scope survives only as a private invocation lease; a previously revoked grant
cannot recreate that lease. Configuration, group, start and enable permissions
are separately rechecked and consumed before privileged APT simulation, whose
root configuration may contain hooks. Both privileged simulation and installation
use explicit actual-root/status settings. The final command uses verified local
archives with `--no-download`, retaining no-upgrade/no-remove gates.

A fixed source-owned Pre-Install-Pkgs protocol-v2 helper admits the actual archive
files and package actions, rehashes their exact bytes and rejects unknown,
duplicate, replacement or unrelated configuration work. A complete machine
package-health snapshot is checked before acquisition and again in the hook;
protocol-v2 alone does not expose implicit ConfigurePending work. Upstream APT
holds its frontend lock at this hook, not its backend dpkg lock; ordinary APT and
direct dpkg honor frontend serialization. Forced root bypass and actual native
lock/child behavior remain outside the proven fixture evidence.

A durable pending fence precedes privileged APT. Timeout or uncertain truncated
results retain the fence and installer data, and retry cannot create new grants.
A confirmed terminal failure re-probes actual package state; compatible completed
packages can be preserved and missing packages resumed with fresh authority.
Fence creation and removal both require file/directory durability. Unknown or
modified private entries are retained rather than recursively deleted. None of
these checks activates the ordinary empty production catalog or proves a native
installation.

See [Linux service startup](setup-arch-services.md) for the separate startup
authority and the native verification still required before profile admission.

### Ordinary-user Docker access on Linux

Exact installed APT and Arch profiles can separately propose adding the current local user
to the system Docker group. This grants **root-equivalent daemon access**; the
human confirmation and grant target state that privilege explicitly. An install
grant for package-created groups cannot authorize user enrollment. The plan binds
the current UID/local account, Docker GID, actual socket identity, authenticated
profile and observed active service configuration. Custom/rootless endpoints and
unverified or inactive services require separate human action.

Already-enrolled users whose current session lacks the group receive new-login
guidance without another prompt or membership change. If the session already
has the group but access is denied, setup preserves the account and reports an
OS access-policy action. Missing membership requires a separately matching
`docker-access` grant. Setup rechecks identities and authority before a bounded,
noninteractive additive `usermod` operation targeting the validated `docker`
group name, preserves all other memberships,
and still requires a new login. It never invokes root Docker or a replacement
shell, changes socket ownership/mode, or starts/enables a service as part of
enrollment. A fresh session must prove its own ordinary-user access.

Once authority is consumed durably before the operation. Uncertain completion
or pending-fence durability failures return recovery status and block daemon
RPC/replay. Confirmed authentication failures preserve observed memberships and
require fresh authority. These public disposable-host fixtures do not prove
native NSS/locking, privileged descendant termination or actual session refresh.
Native profiles remain disabled. The source-owned membership tool policy uses
APT's `passwd`-owned `/usr/sbin/usermod` or Arch's `shadow`-owned
`/usr/bin/usermod`; callers cannot supply a tool path or ownership override. Arch
also rechecks package database health and lock absence during each verified
service/access observation. Actual native session and OS behavior remains pending.
