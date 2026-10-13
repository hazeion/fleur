# First-run bootstrap and prerequisites

Research for [Research npx bootstrap and Bun/Docker prerequisite installation](https://github.com/hazeion/fleur/issues/2), restarted October 12, 2026. This is evidence and a proposed setup contract. It does not approve an installer design or authorize implementation. No system software was installed and no bootstrap behavior was executed.

## Findings

`npx` needs an existing Node/npm installation before Fleur can run. A Node-compatible entry point can check prerequisites and then invoke Bun. An entry point requiring Bun immediately cannot handle missing Bun. This is an architectural inference from npm's execution model. npm downloads missing packages to its cache and adds their binaries to the command's PATH. npm's package-download prompt is separate from Fleur's installation consent. `npx --yes` suppresses that npm prompt; it must not imply consent to install Docker or accept its agreement. Put npx flags before the package name. [npm exec](https://docs.npmjs.com/cli/commands/npm-exec/)

Recommendation: publish a small JavaScript bootstrap with no Bun imports or Bun-only syntax. Bundle its Node dependencies, keep prerequisite checks available before loading the runtime, and hand off with an argument array and inherited working directory. Choose and test a minimum supported Node version separately. Document that users without Node/npm must install those first. Pin the Fleur package version in automation examples to avoid changing the bootstrap between reruns.

Node's `process.arch` describes the architecture of the Node executable, and `process.platform` describes its build platform. It is not sufficient evidence of native hardware on its own. [Node process documentation](https://nodejs.org/api/process.html#processarch) Apple documents that Rosetta translates Intel applications on Apple silicon. [Apple Rosetta guidance](https://support.apple.com/en-us/102527)

Recommendation: distinguish process architecture, host architecture, and selected download architecture. Detect supported macOS/Linux and x64/arm64 combinations before downloads. On Linux inspect distribution identity, release, package architecture, libc, and kernel. Docker's Debian repository instructions use `/etc/os-release` and `dpkg --print-architecture`; use a data parser rather than sourcing an untrusted file into a shell. An Intel Node process on Apple silicon needs an explicit native-hardware probe and a verification fixture before choosing a Docker installer.

### Bun

Bun publishes macOS x64/arm64 and Linux glibc/musl binaries. The checked documentation requires macOS 13+, glibc 2.17+ for glibc downloads, and SSE4.2 on x64. It recommends Linux kernel 5.6+ while describing older-kernel support with degraded syscalls. Its script requires `unzip` on Linux, supports a version argument, and selects libc automatically. Bun documents version/revision checks, an installation directory that may be absent from PATH, and package-manager-specific upgrades. [Bun installation](https://bun.com/docs/installation)

Recommendation: select a tested stable Bun version when the verification contract is approved. Reuse a compatible executable already installed. If Bun exists but is incompatible, report its version and installation source before proposing an upgrade. Avoid overwriting a Homebrew/npm-managed installation. A user-scoped installation should execute through its resolved absolute path for the current invocation, without depending on a new shell loading PATH changes. The exact managed directory, checksums, archive validation, shell-profile policy, and upgrade ownership remain decisions.

### Docker on macOS

Docker provides separate Apple silicon and Intel installers, supports the current and previous two major macOS releases, and requires at least 4 GB RAM. Its documented command-line DMG installation uses elevated commands. Desktop must start and satisfy its agreement before use. The installer offers `--accept-license`; that flag performs acceptance, it does not establish a person's authorization. Recent documented defaults use user-scoped CLI tools and omit the default Docker socket, so checking only a system CLI path or fixed socket is inadequate. [Docker Desktop installation](https://docs.docker.com/desktop/setup/install/mac-install/)

Desktop's license distinguishes personal, educational, noncommercial open-source and qualifying small-business use from categories requiring a subscription. Fleur cannot determine organizational eligibility merely from a machine probe. [Docker Desktop license](https://docs.docker.com/subscription-billing/desktop-license/) Docker documents privileged configuration separately, including system symlinks, host entries and low-port binding. [Mac permissions](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/)

Recommendation: offer the official Desktop installer when absent, report administrator and agreement steps, then resume checks. Require explicit agreement authorization before any acceptance flag. Do not install Rosetta merely to support optional Intel tools. Treat starting Desktop, a locked organizational policy, and agreement acceptance as distinct possible human actions. macOS support must satisfy both Bun's floor and Docker's moving support window; freeze an explicit tested macOS matrix for each Fleur release.

### Docker on Linux

Docker's Ubuntu documentation currently lists 22.04, 24.04 and 26.04 LTS. It supports amd64 and arm64 among other architectures. It documents package conflicts, official apt repository installation, explicit version selection, daemon checks, and a development convenience script that requires root/sudo. Derivatives are not officially supported. Docker-published ports can bypass host firewall rules. [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/)

Docker's Debian documentation lists Debian 12 and 13 and supports amd64/arm64. Its repository recipe installs Engine, CLI, containerd, Buildx and Compose packages, followed by service and container checks. [Docker Debian installation](https://docs.docker.com/engine/install/debian/)

The Docker group grants root-level privileges. Membership changes require a refreshed login session; successful installation under sudo does not prove the invoking user can use Docker. [Docker Linux post-installation](https://docs.docker.com/engine/install/linux-postinstall/) Rootless Docker needs user-namespace prerequisites, including mapping utilities and subordinate UID/GID ranges. Its setup may create a user service and switch the CLI context. [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)

Recommendation: implement an explicit apt-repository plan for a small supported matrix rather than invoking a generic convenience script. Do not remove conflicting packages, change group membership, disable an existing daemon, or switch between rootful and rootless Docker automatically. Present each required change and its consequences. Initially recognize an already working rootless daemon; automated rootless provisioning needs its own tested contract.

## Proposed initial support matrix

This narrows upstream compatibility to a feasible Fleur test matrix. It is a recommendation for the setup decision ticket, not a declaration that these environments have passed tests.

| Environment | Proposed v1 handling | Reason |
| --- | --- | --- |
| Ubuntu 24.04 and 26.04 LTS, amd64/arm64, glibc, systemd | Assisted Engine installation through official apt repository | Two current LTS targets with the same installation family |
| Debian 13, amd64/arm64, glibc, systemd | Assisted Engine installation through official apt repository | Current stable Debian, similar packaging but separate release detection |
| Ubuntu 22.04 and Debian 12 | Consider existing-installation support after CI coverage | Upstream compatibility exists; expanding setup support adds maintenance |
| Other distributions and derivatives, musl hosts, non-systemd systems | Report unsupported assisted installation and link official instructions | Bun compatibility alone does not establish Fleur installation support |
| Existing Linux Desktop or rootless Docker on selected distributions | Detect and reuse after lifecycle tests | Avoid replacing an environment the user already manages |
| macOS, native x64/arm64 | Desktop assistance on release-specific supported macOS versions | Support must intersect Bun and Desktop requirements |

Do not infer support for Podman aliases, remote daemons, or alternative Docker-compatible runtimes from a successful version command. Decide those explicitly. Restrict the initial managed PostgreSQL environment to a confirmed local daemon, since remote endpoints change file, network, ownership and persistence assumptions.

## Readiness and coexistence

Docker Desktop includes Compose. Linux Engine installations can add the Compose plugin separately; the standalone installation is legacy. Check `docker compose version`, not only `docker --version`. [Compose installation](https://docs.docker.com/compose/install/)

Docker contexts describe endpoints and TLS configuration. Environment variables and per-command flags can override the active context. A context named `default` does not prove which daemon a command ultimately targets. [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/) `docker info` returns client/server system information and can format output as JSON. [Docker system info](https://docs.docker.com/reference/cli/docker/system/info/)

Proposed readiness sequence:

1. Find executable and supported client version.
2. Resolve effective endpoint without changing global context or printing credentials.
3. Probe daemon access as the invoking user with a bounded timeout.
4. Check Compose availability and supported features independently.
5. On explicit setup, run a disposable container smoke check, then verify the chosen PostgreSQL image, persistent storage and database health through the later lifecycle contract.

A client version proves presence. Daemon access proves connectivity and permission. Neither proves image-download access or database readiness. Avoid reporting every connection failure as a missing installation. Separate absent CLI, unavailable daemon, denied access, startup timeout, unsupported version, conflicting installation, remote endpoint, and image-pull failure.

## Proposed resumable contract

Noninteractive checks should return structured results without prompts. Suggested fields are schema version, overall state, component states, detected versions, supported status, action identifier, whether a human is required, and a redacted diagnostic. Proposed states are `ready`, `missing`, `incompatible`, `needs-human-action`, and `failed`. Exit-code values, JSON compatibility and timeout limits need human approval in the command contract ticket.

Explicit setup should name exactly which installations are allowed. A generic yes flag should not include legal agreement acceptance or root-level group access. When a human action is needed, return promptly with a stable action identifier and safe next-step guidance. A rerun probes actual state again; a saved checkpoint is not proof of readiness.

Persist only Fleur-owned nonsecret setup metadata. Recheck installed binaries, repository configuration and daemon access before repeating a step. Download to a temporary location and verify before replacement. A failed download must preserve a working existing binary. Concurrent setup attempts need a lock, interruption recovery and a clear ownership policy. Do not delete existing containers, volumes, settings or packages as recovery.

## Evidence gaps and verification requirements

Official docs establish available mechanisms. They do not prove an unattended, resumable Fleur implementation. Before implementation, decide minimum Node/Bun/Engine/Compose versions, supported macOS releases, checksum verification, installation ownership, privileged-change consent, and the exact Linux matrix. Docker and Bun docs are mutable; recheck release-specific requirements when selecting versions. The upstream OS-release manual could not be retrieved in this research session; field parsing and native macOS architecture detection need source review before coding.

Derive tests from these observable requirements:

- A Node-only environment can run help/check and report missing Bun before loading Bun-dependent code.
- x64 Node under Rosetta selects the approved native architecture or gives a precise unsupported result.
- Existing compatible tools cause no install or upgrade; incompatible managed tools produce an explicit plan.
- Missing PATH entries do not cause duplicate installations. Paths and arguments containing spaces survive handoff.
- CLI present but daemon stopped, inaccessible, remote, or slow yields distinct bounded results.
- Compose missing is reported separately from Engine missing.
- Noninteractive setup requiring privilege or agreement returns a human action without hanging or accepting terms.
- Package conflicts leave existing software/data intact. Apt locks and partial repository setup are recoverable.
- Interrupted downloads, stale checkpoints and concurrent runs cannot corrupt a usable executable.
- Every supported OS/architecture passes disposable container and PostgreSQL readiness tests as the ordinary user.
- PostgreSQL storage persists across restart, and setup does not affect unrelated Docker resources.

These are proposed acceptance criteria for later decision and implementation tickets. No runtime, installer, Docker or PostgreSQL test was run for this research document.
