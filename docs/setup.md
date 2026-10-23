# Prerequisite diagnosis and setup

Fleur requires Bun 1.4.3 before invocation. Doctor and setup run through Bun and never invoke Node or npm. `doctor --json` returns one version 1 result; failures identify a stable code, exit category and recovery actions. The default operation deadline is 60 seconds. Help and argument validation do not probe Docker, load native libraries, read grants or create setup state.

Doctor distinguishes native architecture and Rosetta, unsupported targets, missing Docker CLI, an effective remote endpoint, daemon access denial, Compose availability and a digest-pinned owned smoke container. It resolves Docker environment/context overrides and freezes the local Unix endpoint for subsequent requests; it never changes global Docker context. Raw Docker stderr, credentials and private machine identity are not returned. Image acquisition is explicit: doctor never pulls a missing image.

A smoke container uses an existing exact architecture-specific Bun image from the compatibility experiments. It has a nonce name and ownership label, no network, read-only root, dropped capabilities, no-new-privileges and resource limits. Its image identity and ownership are checked before use and removal. The deadline reserves time for cleanup. Unconfirmed cleanup returns `RECOVERY_REQUIRED` with exit 5. No database, existing container or volume is modified.

`setup` rechecks actual prerequisites. A compatible observed installation is preserved. A missing smoke image can be acquired only under a matching human setup grant for the exact action, Docker digest-pull method, local endpoint and image, OS user, machine and plan checksum. Interactive confirmation offers `once`, `remember` or `deny`. JSON and piped invocations cannot create or broaden grants; there is no generic yes flag. A once grant is durably consumed before acquisition, including failed downloads. Reruns inspect actual state rather than replaying a checkpoint. Missing authority returns exit 3 promptly. The supported trust boundary does not prevent unrestricted same-user software from editing Fleur or its private grant storage.

Grants live in the OS user's private state directory outside application projects. `setup grants list` inspects them without changing state. `setup grants revoke <id>` atomically revokes a grant without changing installed software. An OS file lock serializes grant changes and image setup actions; it releases on process death. Contention returns `MAINTENANCE_BUSY` with exit 5. Unsafe, malformed or symlinked state is rejected. Grant records require exact primitive field types; array-to-string coercion never grants authority. Both reads and writes enforce at most 100 records and 64 KiB of encoded UTF-8, including the published newline. A new grant that exceeds either bound is refused before publication or acquisition, preserving all existing authority. No records are silently pruned; existing valid grants remain usable while creation requires explicit store recovery. Never delete another process's lock by guessing whether a PID is stale.

See [Docker Desktop application placement](setup-desktop.md) for its separate authority and recovery rules, and [setup artifact evidence](setup-artifact-evidence.md) for verified payload observations and their native-support limits.

## Current evidence and remaining work

Observed CLI, daemon, Compose and smoke readiness do not automatically admit a release profile. Doctor returns success only when the native host, Bun, Docker CLI build, authoritative Engine/kernel/containerd/runc tuple, Compose and pinned image match a reviewed source-owned readiness policy, the same daemon identity and recorded cgroup driver/operating mode/security options remain observable, advertised CPU/memory/PID enforcement is available, and the owned smoke completes with confirmed cleanup. Advertised capability flags are current-state guards, not a replacement for the recorded isolation experiment. Installation profiles and human grants are separate authority. No user argument, project file or environment variable selects a readiness policy. The source-owned catalog includes exact Ubuntu 24.04 and 26.04 x64 prerequisite tuples. The Ubuntu 24.04 tuple uses Bun 1.4.3, Docker CLI/Engine 29.9.1, kernel 6.8.0-147-generic, containerd 2.4.2, runc 1.5.2 and Compose 5.6.0. Ubuntu 26.04 uses the same component builds with kernel 7.0.0-38-generic. Their recorded cgroup v2 systemd rootful mode and security options must also match. Other tuples retain exit 4 with release state unverified after smoke readiness. The record cites actual readiness and isolation evidence; test policies never admit a platform. The ordinary packed Ubuntu 24.04 and 26.04 paths have passed matching VM verification, including repeated Doctor/setup success, preserved grants/state and the original bounded restriction checks. The exact evidence and remaining platform limits are recorded below. Native Debian/Arch installation and other unmeasured targets remain outside existing evidence.

The exact Ubuntu 24.04 and 26.04 x64 official APT package sets are mapped in the fixed packaged `verified-apt-profiles.json` catalog with authenticated payload hashes and native evidence references. Each exposes a plan without granting permission; each package/configuration/access/service action still requires its own matching human grant. An unavailable stable machine identity returns a human action before reading grants or inspecting packages. Both ordinary packed installation paths have passed their exact VM proofs; the Ubuntu 26.04 path passed two fresh attempts at the same source commit. Both are recorded in the artifact evidence document.

### Installer profiles awaiting qualification

Platforms without an admitted installer row require manual setup. The permitted methods are verified official Docker Desktop on native macOS, Docker's official signed apt repository on Ubuntu 24.04/26.04 and Debian 13 amd64/arm64, and official pacman packages on Arch x86_64. The candidate inventory in `src/setup/installer-candidates.json` records exact available package versions, hashes and sources for research. Artifact authentication and the exact Ubuntu guest installation are recorded separately in the artifact evidence document. Research candidates do not become executable merely by appearing in that inventory. A missing or incompatible source-owned profile requires manual action; the remaining platform evidence leaves this acceptance criterion incomplete.

Installation, repository changes, service starting/enabling, Docker access privileges, PATH/configuration and agreement acceptance require separate authority. Package post-install scripts and Desktop installation can have these side effects; an install grant cannot silently cover them. Fleur never removes conflicts, upgrades or replaces existing installations, edits profiles/context, changes Docker permissions or accepts legal terms automatically.

Official method references: [macOS](https://docs.docker.com/desktop/setup/install/mac-install/), [Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Debian](https://docs.docker.com/engine/install/debian/), [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/), and [Arch packages](https://archlinux.org/packages/extra/x86_64/docker/). Mutable upstream documentation and package availability do not replace native release verification.

### Native apt adapter checkpoint

The compiled native profile catalog includes the admitted exact Ubuntu rows described
above. Research candidate metadata cannot authorize execution. The apt
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

Doctor and setup check retained APT transaction records on Ubuntu and Debian,
and Arch transaction records on Arch, before running host commands. An existing
or unreadable record returns `RECOVERY_REQUIRED` with exit 5 even if Docker
would otherwise be ready. Malformed records, directories and dangling symlinks
remain blocking evidence. This check preserves pending state, grants and private
artifacts; it does not reconcile an interrupted transaction. Legacy records lack
the boot and artifact identity needed for safe automatic recovery.

New APT package actions require an observed kernel boot UUID before requesting
authority. Their format-2 pending record preserves the original host observation,
operation and profile identity, historical grant records, and an inventory of the
owned installer files and directories. Device/inode values retain their full
precision; files include their verified digest and size. Stage files and
directories are synced before the pending record and its parent directory, and
all of that precedes privileged APT. A durability failure prevents launch and
retains the private evidence. This supplies recovery custody, not a completed
reconciliation path; both legacy and unresolved format-2 records still block.

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
these fixture checks alone admits a native platform. The separately recorded
Ubuntu guest execution and completed ordinary packed qualification apply only to the exact admitted row.

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

APT setup excludes optional recommended and suggested packages consistently in initial planning, privileged local-archive planning and installation. Simulations use APT's quiet level 2 and disable its nonroot simulation note so the strict operation validator sees the package actions. These output options apply only to simulations; installation retains its separately authorized guarded command. Extra, removed, changed-version or unrecognized operations still stop setup. This policy has command-protocol coverage; native installation evidence remains pending.

APT artifact resolution accepts the frozen URL literally or its exact APT path encoding for plus, tilde and percent. It does not decode arbitrary returned URLs or broaden their origin or path. The exact size, payload hash and package control checks remain required. An unconfirmed URI-resolution process stops with recovery required before acquisition authority is consumed or a payload download begins.

After signed-repository planning and authenticated payload acquisition, APT's privileged local-archive simulation and installation use the same owned empty source list and source-parts directory. An owned literal configuration clears inherited `APT::Sources::With` entries before the fixed command options are applied. Installed dependencies still come from the actual package database; missing dependencies fail instead of being fetched. Setup verifies these inputs' exact bytes, ownership, modes and identities before both commands and checks the directory for any entry. Changes retain recovery state. No repository configuration or package cache is replaced. This behavior has command-protocol coverage; actual native installation remains a separate verification requirement.

The APT pre-install guard emits a bounded `FLEUR_APT_GUARD_REFUSAL` stderr record
when it refuses the operation. Version 1 contains a fixed validation-stage name,
without input values, paths, package state or exception details. Protocol-action
refusals also include a fixed reason naming the rejected constraint. Archive-path
mismatches include `pathEquivalence`: `canonical-path-equal` means lexical path
resolution agrees, and `different-path` means it differs. This does not inspect
filesystem identity, and both mismatches remain refused. Other stages have no
reason or path-equivalence field. The stage
identifies the last validation group reached; it does not prove the cause of a
failure or the resulting package state. Delivery is best effort, so an absent
record supplies no diagnostic evidence. This does not change the public setup
result, grant consumption, recovery checks or the required success receipt.

Local APT transactions use a private archive cache populated from the already
authenticated downloads. Copies retain the frozen package identity, size and
SHA256, and use APT's canonical package/version/architecture filename. The exact
copied paths and inodes become the guard inputs. This supplies complete local
archives before `--no-download` installation; queued local-file acquisition alone
can leave APT without an absolute install operand. Both privileged simulation and
installation use the same private cache and empty private lists directory. Signed
repository acquisition and the actual dpkg status database remain unchanged.

Fleur creates and binds the private cache lock, partial directory and lists
auxfiles directory before APT. It rejects replaced nodes, modified copies and
unknown entries before privileged commands. After a confirmed terminal install,
APT may have changed the owner of the original partial or auxfiles directory.
Fleur removes only those original empty directory inodes, with their required
modes, using nonrecursive removal. Replaced or nonempty directories, changed lock
metadata or uncertain command termination preserve recovery evidence and block
replay. Cleanup uses no sudo operation and never removes a global APT cache.
Command fixtures cover this behavior; actual sandbox-account ownership changes
and successful native installation still require the guest verification gate.

Passive activation observation recognizes loaded sockets in stable listening or
running states. A matching socket still blocks Docker RPC unless every reported
activation target is already an active, running service. Filesystem Stream,
Datagram and SequentialPacket listeners must be sockets. An accessible FIFO must
be a FIFO with a distinct device/inode from the selected Docker socket; a
contradictory observed type or identity is never ignored.

A protected FIFO has one narrowly scoped alternative when direct stat completes
with exit1, empty stdout, an exact C-locale path-specific permission-denied error
and confirmed command termination. The trusted system manager must report the
unit as loaded and active in a stable listening or running state, with an
absolute FIFO Listen path. That retained FIFO transport cannot receive AF_UNIX
socket RPC; this is transport exclusion, not proof of its inaccessible pathname
identity. Before contacting the selected Docker socket, Fleur must observe the
same complete socket inventory, selected socket identity and every observed
unit's full metadata again, including initially inactive units. Any change
remains activation-unknown. The two default Docker socket paths cannot use this
FIFO alternative.

This alternative trusts the system manager and kernel to preserve the declared
FIFO transport type. Repeated observations detect changes but are not atomic;
contradictory manager or filesystem evidence must remain activation-unknown.

Unknown kinds, malformed or nonexact errors, timeouts, uncertain termination,
conflicting types and inconsistent identities remain activation-unknown. Special
listeners retain their direct type/identity requirement. Finding an unrelated
FIFO never stops inspection of later units or other Listen entries; unknown
UNIX-socket owners and stopped activation targets still block RPC. These passive
checks neither grant service startup authority nor contact the daemon.


On Linux, a protected filesystem socket listener may use a private, unprivileged
Unix SOCK_DIAG capability only on the same exact completed permission-denied
response. Both `stat: cannot statx` and `/usr/bin/stat: cannot statx` program-name
spellings are recognized, with the exact requested path and C-locale error; a
generic permission-denied message is insufficient. This spelling recognition
also applies to the protected FIFO alternative above. The selected
Docker endpoint still requires direct socket stat. The fallback requires positive
NAME/VFS evidence for a unique binding, two complete kernel dumps with stable
relevant identities and cookies, and fresh inventory, selected-socket, every observed socket unit and matching
trigger metadata checks. Kernel names retain exact UTF-8 bytes, including any
leading BOM; they are not normalized into a different pathname. Accepted stream children do not count as listening
bindings. Bound datagrams in connected or unconnected states remain eligible.
The two dump calls share a three-second collection allowance; metadata commands
retain the original readiness deadline. Missing, ambiguous, changed or incomplete
evidence remains activation-unknown. No dump completion alone authorizes RPC.

Kernel VFS inode values are only 32 bits. The fallback refuses larger selected
filesystem inodes; an equal tuple is treated as a possible match and retains all
trigger checks. Kernel and stat device encodings are compared as major/minor
pairs. Stable observations do not constitute an atomic snapshot or contain
arbitrary root/same-user path mutation outside the supported grant boundary.
The Linux FFI adapter loads only when needed and closes its dedicated netlink
socket on every path. It never connects to the observed Unix socket, changes
permissions, invokes sudo or exposes raw kernel records in CLI output.

Special listeners are admitted only when passive stat proves a distinct character
special file, such as rfkill. They use filesystem device/inode identity rather
than the device's target number, and never use a Unix socket diagnostic fallback.
The fixed passive stat command runs with C locale for exact type/error parsing.

Verified Linux service and access observation accepts a running Docker socket
when the Docker service is also active and running. An inconsistent or
transitional pair requires human inspection. Enrollment still checks package and
unit provenance, local user/group identity and socket ownership, then requires
its own scoped Docker-access grant; it does not start or restart services.

Service metadata treats a present empty `Job=` as idle, alongside the supported
zero spelling. Missing Job metadata and active job IDs remain refused. The
Docker socket may require the implicit `system.slice` dependency; other slices
or unreviewed dependencies are not admitted. Unit enablement, provenance and
separate access/startup authority checks remain unchanged.

The reviewed Docker socket may declare the root filesystem dependency `-.mount`.
Systemd derives mount requirements from filesystem listener paths
([socket source](https://github.com/systemd/systemd/blob/v255/src/core/socket.c)).
Only this exact mount is admitted, only in `docker.socket` Requires. Access and
startup observations require it to be active when declared, using an explicit
`--` before its name. Startup includes the declared prerequisite in its plan and
checksum and rejects declaration changes after authorization. No mount operation
is authorized; arbitrary mount dependencies remain refused.

For the measured Ubuntu 26.04 APT profile, service/access provenance also accepts
Ubuntu's default sudo-rs alternatives layout. It requires the exact root-owned
`/usr/bin/sudo` → `/etc/alternatives/sudo` → `/usr/lib/cargo/bin/sudo` chain,
protected canonical provider directories, a root-owned single-link setuid target,
installed `sudo-rs` package ownership and clean package verification. The same
checks cover all path ancestors and run again after human confirmation. They do
not provide an atomic guarantee against concurrent changes by another root
administrator. Unknown aliases and altered providers
require manual action; Fleur never changes the selected provider. Existing
regular-file sudo checks remain in place for other reviewed layouts. Two owned Ubuntu 26.04 installation/runtime attempts exercised this layout;
ordinary packed verification is recorded separately in the artifact evidence. Ubuntu documents the
provider choice in its [user-management guide](https://ubuntu.com/server/docs/how-to/security/user-management/).
