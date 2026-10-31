# Version string forms and floor comparison rules

Research for [Research version string forms and comparison rules for Bun, Docker, macOS and kernels](https://github.com/hazeion/fleur/issues/130), checked October 31, 2026. It supports the version-admission map (#124) and its settled decisions: identity facts stay exact, numeric versions become pure floors with no ceiling (#126). This note is evidence and a proposed comparison contract; it does not authorize implementation. Sources are upstream source trees, release pages and vendor documentation. Local observations were made on macOS 15.7.7 with Bun 1.4.3 and 1.4.4 and are labelled as such. No tool was installed or upgraded.

## Summary

Every machine tool Fleur compares publishes a three-component numeric release (`X.Y.Z`) for stable builds; none ships a fourth numeric component. The differences are in decoration: a `v` prefix (containerd, Compose tags), pre-release suffixes (`-rc.N`, `-beta.N`, `-canary.N`, `-rcN`), build or dirty markers (`+sha`, `+`, `-dirty`, `.m`), distro repack suffixes (`+dfsg1`, `~ds1`) and kernel ABI/flavour tails (`-147-generic`, `+deb13-cloud-amd64`, `-linuxkit`). Two-component forms occur legitimately for macOS (`26.0`), Ubuntu (`24.04`), Debian (`13`) and an upstream `.0` kernel (`7.0`).

Recommended rule: parse each string with a tool-specific grammar into a numeric core plus an identity tail; pad the numeric core to the floor's length with zeros; compare lexicographically; require the identity tail to match the floor exactly; refuse pre-release markers as a distinct reportable reason; refuse anything else as unparseable. Two findings change the current `src/setup/readiness.ts` parser: it cannot pad component counts (an upstream `7.0-linuxkit` kernel or a `26.0` macOS release would fail), and it has no Debian grammar (an ABI serial such as `+deb13.1` would read as a different flavour). One finding changes the planned CLI gate: `Bun.semver.satisfies` returns `true` for an unparseable range, so the floor string must be validated before it is used.

## 1. Bun

### Forms

Bun's version constants live in `src/bun_core/Global.rs`. `package_json_version` is `X.Y.Z` (or `X.Y.Z-debug`) and its doc comment says it "does not have the canary tag, because it is exposed in `Bun.version`". `package_json_version_with_canary` is `X.Y.Z-canary.N`; `package_json_version_with_revision`, "what is printed by `bun --revision`", is `X.Y.Z+sha`, `X.Y.Z-canary.N+sha` or `X.Y.Z-debug+sha`. [Global.rs](https://github.com/oven-sh/bun/blob/main/src/bun_core/Global.rs) The version string is always exactly three components and the short SHA is nine characters. [env.rs](https://github.com/oven-sh/bun/blob/main/src/bun_core/env.rs) The canary number is the commit count ahead of the latest release tag. [ci.ts](https://github.com/oven-sh/bun/blob/main/.buildkite/ci.ts)

`bun --version` prints `package_json_version`, so it never shows `-canary.N` or `+sha`, even on a canary build; `bun --revision` prints the form with both. [cli/mod.rs](https://github.com/oven-sh/bun/blob/main/src/runtime/cli/mod.rs) `Bun.version` is the same plain `X.Y.Z`; `Bun.revision` is the full 40-character SHA. [BunObject.cpp](https://github.com/oven-sh/bun/blob/main/src/jsc/bindings/BunObject.cpp), [Bun.version docs](https://bun.com/docs/api/utils) The installation docs show `bun --version` as `1.x.y` and `bun --revision` as `1.x.y+<sha>`, and describe `bun upgrade --canary` and `--stable`. [Installation](https://bun.com/docs/installation) Stable release tags are `bun-vX.Y.Z`; the `v` is only in the tag. [bun-v1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3) The `canary` tag is one rolling pre-release titled with a commit SHA and no semver string. [canary](https://github.com/oven-sh/bun/releases/tag/canary)

Observed locally (Bun 1.4.4): `bun --version` prints `1.4.4`, `bun --revision` prints `1.4.4+38afee6c8`, `Bun.version` is `"1.4.4"`, `Bun.revision` is 40 hex characters, and the undocumented non-enumerable `Bun.version_with_sha` is `"v1.4.4 (38afee6c8)"`, with a `v`. Bun 1.4.3 behaved the same with its own SHA. A canary binary was not available locally; the canary forms above are from source.

### `engines.bun`

Bun does not read `engines`. The `bun install` npm-flag table lists `--ignore-engines` as "Nothing: `engines` is not checked". [bun install](https://bun.com/docs/pm/cli/install) The feature request to support `engines` is open, as is the request to respect `engineStrict`. [#5846](https://github.com/oven-sh/bun/issues/5846), [#14030](https://github.com/oven-sh/bun/issues/14030) `bun`, `bun run`, `bunx` and `bun install` therefore ignore both `"1.4.3"` and `">=1.4.3"`: no warning, no refusal. npm's own `engines` handling documents `node` and `npm` and is advisory unless `engine-strict` is set; it says nothing about a `bun` key. [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) GitHub's `setup-bun` action reads `packageManager`, then `engines.bun`, then falls back to `latest`, and accepts wildcard patterns such as `1.0.x`; the README does not define how a range resolves. [setup-bun](https://github.com/oven-sh/setup-bun) Fleur's CI does not use that action: `experiments/compatibility/platforms/bootstrap.py` downloads the exact `bun-v1.4.3` release and fails unless `bun --version` is `1.4.3`, which satisfies decision #129 (CI installs the exact floor) independently of `engines.bun`.

### Pre-release handling in `Bun.semver`

`Bun.semver` is documented as node-semver compatible, with `satisfies(version, range)` and `order(a, b)`; the page does not mention pre-release rules. [Bun.semver](https://bun.com/docs/api/semver) node-semver admits a pre-release only when a comparator with the same `[major, minor, patch]` tuple also carries a pre-release tag. [node-semver prerelease tags](https://github.com/npm/node-semver#prerelease-tags) Bun's tests assert the same (`">=7.0.0"` does not admit `7.0.0-rc2`). [semver.test.ts](https://github.com/oven-sh/bun/blob/main/test/cli/install/semver.test.ts) Observed locally on Bun 1.4.4:

| Call | Result |
| --- | --- |
| `satisfies("1.4.4", ">=1.4.3")` | true |
| `satisfies("2.0.0", ">=1.4.3")` | true |
| `satisfies("2.0.0", "^1.4.3")` | false (caret is a ceiling) |
| `satisfies("1.4.4-canary.1", ">=1.4.3")` | false |
| `satisfies("1.4.3-canary.1", ">=1.4.3")` | false |
| `satisfies("v1.4.3", ">=1.4.3")`, `satisfies("1.4.3+abc", ">=1.4.3")` | true |
| `satisfies("1.4", ">=1.4.3")`, `satisfies("1.4.4.1", ">=1.4.3")`, `satisfies("abc", ">=1.4.3")` | false |
| `satisfies("1.4.4", "not a range")`, `satisfies("1.4.4", "")`, `satisfies("1.4.4", ">=abc")` | **true** |

The last row matters: an unparseable range admits everything. A typo in `engines.bun` would silently disable the gate.

### Recommendation for the CLI gate

Express the floor in `package.json` as `"engines": { "bun": ">=1.4.3" }`. Nothing in Bun or npm acts on it, so it is documentation plus the value `src/cli/main.ts` reads. Before any comparison, require the stored value to match `^>=(\d+)\.(\d+)\.(\d+)$` and `Bun.version` to match `^\d+\.\d+\.\d+$`; refuse otherwise with a distinct code, never by passing an unvalidated string to `Bun.semver.satisfies`. After validation, either `Bun.semver.satisfies(Bun.version, floor)` or Fleur's numeric compare is correct; the shared numeric compare keeps one implementation across Bun, Docker and OS floors. Reject caret, tilde or upper-bound forms at validation time because decision #126 admits no ceiling. Report `Bun.revision` alongside `Bun.version` in doctor output. Canary builds report the plain release number in `Bun.version`, so a canary of the floor release itself claims equality while being older than the release; detecting that needs `bun --revision` (documented) or `Bun.version_with_sha` (undocumented). Recommend that `fleur doctor` runs `bun --revision` on the invoking executable, reports it, and treats `-canary.` or `-debug` as a pre-release refusal, while the CLI start gate stays on `Bun.version` alone.

## 2. Docker Engine, CLI, Compose, containerd and runc

### Engine and CLI

Release tags moved from `v17.03.0-ce` through `v20.10.0-beta1` and `v23.0.0-rc.1` to `docker-v29.9.2`; since v29 tags carry a `docker-` prefix. [moby releases](https://github.com/moby/moby/releases), [v20.10.0-beta1](https://github.com/moby/moby/releases/tag/v20.10.0-beta1), [v23.0.0-rc.1](https://github.com/moby/moby/releases/tag/v23.0.0-rc.1) Pre-releases since 23.0 use the dotted `-beta.N` and `-rc.N` forms. [beta tags](https://github.com/moby/moby/releases?q=beta), [rc tags](https://github.com/moby/moby/releases?q=rc) The build strips the tag prefix (`VERSION=${VERSION#refs/tags/docker-v}`, `${VERSION#refs/tags/v}`) and defaults to `dev`, so `Server.Version` and `Client.Version` never carry `v` in official builds but can be `dev`, a branch name or `pr-NNNN` in developer builds. [hack/make.sh](https://raw.githubusercontent.com/moby/moby/master/hack/make.sh), [cli .variables](https://raw.githubusercontent.com/docker/cli/master/scripts/build/.variables) `docker --version` is `Docker version {{.Version}}` with `Version` formatted as `<version>, build <commit>`. [docker.go](https://raw.githubusercontent.com/docker/cli/master/cmd/docker/docker.go), [cobra.go](https://github.com/docker/cli/blob/master/cli/cobra.go)

Docker's own apt packages have distro-styled package versions (`5:29.8.2-1~ubuntu.24.04~noble`; an RC would be `29.9.0~rc.1`) but the packaging self-test asserts the binary prints `Docker version $(VERSION), build $(ENGINE_GITCOMMIT)` with the plain upstream version. [gen-deb-ver](https://raw.githubusercontent.com/docker/docker-ce-packaging/master/deb/gen-deb-ver), [deb rules](https://raw.githubusercontent.com/docker/docker-ce-packaging/master/deb/common/rules) Debian's `docker.io` injects `DEB_VERSION_UPSTREAM`, which keeps the repack suffix, so it reports `26.1.5+dfsg1` or `28.5.2+dfsg4`, and sets `PlatformName` empty. [Debian docker.io rules](https://sources.debian.org/src/docker.io/28.5.2+dfsg4-5/debian/rules/), [dpkg pkg-info.mk](https://sources.debian.org/src/dpkg/sid/scripts/mk/pkg-info.mk/), [Debian package versions](https://packages.debian.org/search?keywords=docker.io&searchon=names&exact=1&suite=all&section=all) Ubuntu's `docker.io` uses the same rules with an upstream part lacking a repack suffix, so it reports plain `29.1.3` or `24.0.7` with an empty platform name; the `-0ubuntu...` part is dpkg-only. [Ubuntu docker.io rules](https://git.launchpad.net/ubuntu/+source/docker.io/tree/debian/rules), [Ubuntu package versions](https://packages.ubuntu.com/search?keywords=docker.io&searchon=names&exact=1&suite=all&section=all) These distro outputs were inferred from build rules, not observed live.

### Platform name and Desktop product version

The daemon sets `Platform.Name` from `dockerversion.PlatformName`, default empty, injected at link time; Docker's packaging exports `PLATFORM=Docker Engine - Community`. [daemon/info.go](https://raw.githubusercontent.com/moby/moby/master/daemon/info.go), [version_lib.go](https://github.com/moby/moby/blob/master/dockerversion/version_lib.go), [.go-autogen](https://raw.githubusercontent.com/moby/moby/master/hack/make/.go-autogen), [common.mk](https://raw.githubusercontent.com/docker/docker-ce-packaging/master/common.mk) The CLI reference shows `Server: Docker Desktop 4.19.0 (12345)` next to `Server: Docker Engine - Community`. [docker version](https://docs.docker.com/reference/cli/docker/version/) The parenthesised number is Desktop's build number: the 4.96.1 download URL contains `244132`, matching the measured `Docker Desktop 4.96.1 (244132)`. Release notes also show Desktop bundling components independently (4.96.0: Engine v29.9.1, containerd v2.4.2; 4.96.1: Engine 29.9.2; 4.96.2: Compose v5.6.1; runc last changed at 4.88.0), so the Desktop product version and each component version are separate floors. [Desktop release notes](https://docs.docker.com/desktop/release-notes/) `Docker Engine - Enterprise` was not found on current docs.docker.com and is unverified. Current `docker info` has no platform field; it reports `ServerVersion` and `KernelVersion`. [docker system info](https://docs.docker.com/reference/cli/docker/system/info/)

### containerd

Tags are `v<major>.<minor>.<patch>`, optionally with alpha, beta or release-candidate qualifiers; observed `v2.4.2`, `v2.4.0-rc.0`, `v2.4.0-beta.0` (RC numbering starts at 0). [RELEASES.md](https://github.com/containerd/containerd/blob/main/RELEASES.md), [containerd releases](https://github.com/containerd/containerd/releases) The upstream Makefile injects `git describe --match 'v[0-9]*' --dirty='.m' --always`, keeping the `v`, so Docker's `Components` row reads `v2.4.2`; the compiled default is `2.4.0+unknown`. [Makefile](https://raw.githubusercontent.com/containerd/containerd/main/Makefile), [version.go](https://raw.githubusercontent.com/containerd/containerd/main/version/version.go) Debian and Ubuntu inject `DEB_VERSION_UPSTREAM` without a `v`, yielding `1.7.24~ds1`, `2.1.9+ds1`, `2.2.1` or `2.3.4+dfsg1` (inferred from rules). [Debian containerd rules](https://sources.debian.org/src/containerd/2.1.9+ds1-5/debian/rules/), [Ubuntu containerd rules](https://git.launchpad.net/ubuntu/+source/containerd/tree/debian/rules)

### runc

Tags are `v1.5.2`, pre-releases `v1.6.0-rc.1`; older pre-releases used `rc93` without a dot. [runc releases](https://github.com/opencontainers/runc/releases), [Debian runc versions](https://packages.debian.org/search?keywords=runc&searchon=names&exact=1&suite=all&section=all) The version is the embedded `VERSION` file (`1.6.0-rc.1+dev` on main) with no `v`; the commit is `git describe --dirty --long --always`, which produces `v1.5.2-0-g29dd3dc2` and can gain `-dirty`. [main.go](https://raw.githubusercontent.com/opencontainers/runc/main/main.go), [Makefile](https://raw.githubusercontent.com/opencontainers/runc/main/Makefile), [VERSION](https://raw.githubusercontent.com/opencontainers/runc/main/VERSION) Distro builds set the version to `DEB_VERSION_UPSTREAM` (`1.3.6+ds1`, `1.3.4`) and the commit to the dpkg version (`1.3.6+ds1-1`), not a git-describe string. [Debian runc rules](https://sources.debian.org/src/runc/1.3.6+ds1-1/debian/rules/), [Ubuntu runc rules](https://git.launchpad.net/ubuntu/+source/runc/tree/debian/rules)

### Compose

`docker compose version --short` prints `internal.Version` with a leading `v` trimmed (`5.6.0`); the default text form is `Docker Compose version v5.6.0` and JSON is `{"version":"v5.6.0"}`; the default value is `dev`. [version.go](https://raw.githubusercontent.com/docker/compose/main/cmd/compose/version.go), [variables.go](https://raw.githubusercontent.com/docker/compose/main/internal/variables.go), [compose version reference](https://docs.docker.com/reference/cli/docker/compose/version/) Tags are `v5.6.1`, pre-releases `v5.0.0-rc.1`. [compose releases](https://github.com/docker/compose/releases)

### Recommendation

Keep `^\d+\.\d+\.\d+$` for Engine, CLI, runc and Compose and `^v\d+\.\d+\.\d+$` for the containerd component row; the `v` presence is part of the measured identity because distro builds drop it. Recognise `-(rc|beta|alpha)\.?\d+` after the numeric core as a pre-release and refuse it with a reportable reason, not as unparseable; a pre-release above the floor is still refused because the measured rows are stable releases and decision #126 defines floors over releases. Refuse `dev`, `pr-*`, `+unknown`, `.m`, `-dirty`, `+dfsg`, `~ds` and anything else as unparseable. For `Platform.Name`, keep the product prefix exact, compare the version as a floor and ignore the build number, as `platformAdmitted` already does; an empty platform name never matches a measured row. Keep commit identities free-form under `minimum` admission; runc's `GitCommit` is a `git describe` string, not a hash.

## 3. macOS

`sw_vers` documents `ProductVersion` as the release, for example `11.3` or `12.0`, and `ProductVersionExtra` as the Rapid Security Response letter such as `(a)`, printed separately; the `(a)` never appears in `--productVersion` (Apple man page `sw_vers(1)`, dated 2022-10-27, read on the local host). Apple's release manifests name releases as two components (`macOS 26.0`, `macOS 15.6`) and its security table lists shipped versions such as `26`, `26.0.1`, `26.1`, `15.7.7`. [distribution-macOS 26.0](https://github.com/apple-oss-distributions/distribution-macOS/blob/macos-260/release.json), [Apple security releases](https://support.apple.com/en-us/100100) Apple's composed RSR form is `13.4.1 (a)`. [RSR advisory](https://support.apple.com/HT213825) From macOS 26.1 Apple describes Background Security Improvements versioned `a`, `b` relative to the base release; how they appear in `sw_vers` is not stated. [Background Security Improvements](https://support.apple.com/en-us/102657) Observed locally: `sw_vers --productVersion` and `sysctl kern.osproductversion` both return `15.7.7`; `--productVersionExtra` prints an empty line when none is installed. Fleur's `src/setup/host.ts` already reads `kern.osproductversion`.

The Darwin kernel release does not track the macOS minor. macOS 15.6 shipped `xnu-11417.140.69`, and the local 15.7.7 host still reports `uname -r` `24.6.0` with `xnu-11417.140.69.710.16`; macOS 26.0 ships `xnu-12377.1.9` (Darwin 25). The Darwin version is read from the SDK's `System.kext` `CFBundleVersion`, not the xnu source. [xnu README](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/README.md), [xnu tags](https://github.com/apple-oss-distributions/xnu/tags) Node's `os.release()` is `uname(3)`, so on macOS it is the Darwin release, and Bun implements `node:os` fully. [os.release](https://nodejs.org/api/os.html#osrelease), [Bun node:os](https://bun.com/docs/runtime/nodejs-apis)

Recommendation: compare `ProductVersion` only, parsed as `^\d+(?:\.\d+){0,2}$`, padded to three components (`26.0` is `26.0.0`), lexicographic. Never derive a macOS floor from `os.release()`; it proves at most the major line. Report `ProductVersionExtra` when present but exclude it from comparison, since it is an additive security patch on top of the same release.

## 4. Linux releases and kernels

### Distribution releases

`host.ts` reads `VERSION_ID` from `/etc/os-release`: Ubuntu `24.04` (no point release), Debian `13`. Compare `^\d+(?:\.\d+){0,2}$` numerically after padding, with the distribution `ID` exact. Note the consequence of a pure minimum: an Ubuntu 24.04 floor admits interim releases such as 24.10 and 25.04, which Canonical supports for nine months, not only the next LTS. [Ubuntu release cycle](https://ubuntu.com/about/release-cycle) Restricting to LTS would be an identity rule needing its own decision; this note does not propose one.

### Upstream kernel release

`KERNELVERSION = $(VERSION)$(if $(PATCHLEVEL),.$(PATCHLEVEL)$(if $(SUBLEVEL),.$(SUBLEVEL)))$(EXTRAVERSION)`, so a `.0` release reads `6.17`, not `6.17.0`; an RC reads `6.18-rc3` via `EXTRAVERSION`. [Makefile](https://github.com/torvalds/linux/blob/master/Makefile), [v6.17 Makefile](https://github.com/torvalds/linux/blob/v6.17/Makefile), [v6.18-rc3 Makefile](https://github.com/torvalds/linux/blob/v6.18-rc3/Makefile) `uname -r` is `KERNELRELEASE` from `scripts/setlocalversion`: version, then `localversion*` files, `CONFIG_LOCALVERSION`, `LOCALVERSION`, then an SCM part that is `-NNNNN-g<sha>` under `CONFIG_LOCALVERSION_AUTO`, a bare `+` when past a tag without `LOCALVERSION` set, and `-dirty` for uncommitted changes. [setlocalversion](https://github.com/torvalds/linux/blob/master/scripts/setlocalversion), [init/Kconfig](https://github.com/torvalds/linux/blob/master/init/Kconfig) Node's `os.release()` returns this string unchanged on Linux. [os.release](https://nodejs.org/api/os.html#osrelease)

### Ubuntu

Canonical explains `5.4.0-12.15-generic`: `5.4` is the upstream version, `.0` "an obsolete parameter left over from older upstream kernel version naming practices", `-12` the ABI bump, `.15` the upload number, `-generic` the flavour; the mainline sublevel (`5.4.8` in the example) is tracked separately in `/proc/version_signature`. [ubuntu.com/kernel](https://ubuntu.com/kernel) `uname -r` drops the upload number: Launchpad `6.8.0-147.147` is `6.8.0-147-generic`; `7.0.0-38.38` is `7.0.0-38-generic`. [linux on Launchpad](https://launchpad.net/ubuntu/+source/linux) Cloud flavours number their ABIs from the 1000s (`linux-azure` `7.0.0-1004.4`, `6.8.0-1007.7`), hence `6.17.0-1022-azure`; the Ubuntu wiki pages that documented this convention returned 404 on the research date, so the rationale is unverified. [linux-azure on Launchpad](https://launchpad.net/ubuntu/+source/linux-azure) Ubuntu 24.04 can report `6.8.0-N-generic`, `6.17.0-N-generic` or `7.0.0-N-generic` through the HWE stack, which desktop installs track by default. [Kernel lifecycle](https://ubuntu.com/kernel/lifecycle), [Kernel variants](https://ubuntu.com/kernel/variants)

So in `6.8.0-147-generic`, the version is `6.8.0-147` (major, minor, always-zero sublevel, ABI) and the flavour `generic` is identity. The ABI is monotone within one upstream series, and a higher upstream series always sorts above, so a lexicographic compare over `[6, 8, 0, 147]` is correct for a floor.

### Debian

The kernel handbook defines the ABI name as `upstreamversion+release[.serial]` for official packages, changed for every package version "either the upstream version changes or the serial number is added or incremented"; before Debian 13 it was `upstreamversion-serial` with the third upstream component always `0`. The `uname -r` string is `abiname[-featureset]-flavour`. [Kernel handbook, versions](https://kernel-team.pages.debian.net/kernel-handbook/ch-versions.html) Flavours include `amd64`, `cloud-amd64` and `rt-amd64`. [Kernel handbook, packaging](https://kernel-team.pages.debian.net/kernel-handbook/ch-packaging.html) Examples: trixie `linux-image-6.12.113+deb13-cloud-amd64` (package version `6.12.113-1`); trixie-backports `linux-image-7.2.11+deb13-amd64` (`7.2.11-1~bpo13+1`, same `+deb13` ABI release); bookworm `6.1.0-54-amd64`; bullseye `5.10.0-46-amd64`. [trixie cloud-amd64](https://packages.debian.org/trixie/linux-image-cloud-amd64), [trixie-backports amd64](https://packages.debian.org/trixie-backports/linux-image-amd64), [bookworm amd64](https://packages.debian.org/bookworm/linux-image-amd64), [bullseye amd64](https://packages.debian.org/bullseye/linux-image-amd64)

So in `6.12.113+deb13-cloud-amd64`, the version is `6.12.113` (real upstream sublevel, unlike Ubuntu), `deb13` is identity (the Debian release the ABI belongs to), an optional `.serial` is a numeric ABI bump, and `cloud-amd64` is the flavour. The current parser treats everything after `6.12.113` as the flavour, which works for the measured string but would refuse `6.12.120+deb13.1-cloud-amd64` as a flavour mismatch.

### linuxkit

Docker Desktop's VM kernel sets `CONFIG_LOCALVERSION="-linuxkit"` with `CONFIG_LOCALVERSION_AUTO` unset, so `7.0.14-linuxkit` is upstream `7.0.14` plus a fixed localversion; linuxkit tags kernels by upstream version (`6.6.13`). [linuxkit config](https://raw.githubusercontent.com/linuxkit/linuxkit/master/kernel/6.12.x/config-x86_64), [linuxkit kernels](https://github.com/linuxkit/linuxkit/blob/master/docs/kernels.md) A `.0` upstream release would read `7.0-linuxkit`, two components, which the current length check refuses.

### Recommendation

Use three kernel grammars, selected by the floor's own shape so that a host can never be compared under a different grammar than its measured row:

| Grammar | Pattern | Numeric core | Identity (exact) |
| --- | --- | --- | --- |
| Ubuntu | `^(\d+)\.(\d+)\.(\d+)-(\d+)-([a-z][a-z0-9-]*)$` | major, minor, sublevel, ABI | flavour |
| Debian 13+ | `^(\d+)\.(\d+)(?:\.(\d+))?\+deb(\d+)(?:\.(\d+))?-([a-z][a-z0-9-]*)$` | major, minor, sublevel, serial (default 0) | `deb<N>`, flavour |
| Localversion | `^(\d+)\.(\d+)(?:\.(\d+))?(-[a-z][a-z0-9-]*)$` | major, minor, sublevel (default 0) | localversion (`-linuxkit`) |

Check markers before grammars, because the grammars would otherwise swallow them: `-rc\d+` anywhere after the numeric core is a pre-release refusal, and a trailing `+`, `-dirty` or `-\d+-g[0-9a-f]+` is an unparseable refusal (checked against the samples above, `6.18-rc3` otherwise parses as localversion `-rc3` and `6.1.0-14595-g292a089d78d3` as an Ubuntu ABI with flavour `g292a089d78d3`). Any remaining string matching no grammar is unparseable. Pre-Debian-13 `6.1.0-54-amd64` parses under the Ubuntu grammar with `amd64` as flavour; that is acceptable because its Debian release is already an exact identity fact.

## 5. Proposed comparison contract

One shared primitive: `admitFloor(observed: number[], floor: number[])` pads the shorter array with zeros to the longer length and compares lexicographically; equal admits. Each tool contributes a grammar that returns `{ numbers, identity, prerelease? }` or `undefined`. Admission requires a parse, no pre-release marker, identical identity, and `admitFloor`. Refusals carry one of three reasons so that `fleur doctor` can report them distinctly: below floor, pre-release, unparseable.

| Tool | Source | Numeric core | Identity (exact) | Pre-release (refuse, report) | Unparseable (refuse) |
| --- | --- | --- | --- | --- | --- |
| Bun | `Bun.version`; floor from validated `engines.bun` `>=X.Y.Z` | `X.Y.Z` | none | `-canary.N`, `-debug` seen only via `bun --revision` | anything else, including an invalid floor string |
| Docker Engine, CLI | `Server.Version`, `Client.Version`, `docker --version` | `X.Y.Z` | no `v` | `-rc.N`, `-beta.N`, legacy `-rcN`, `-betaN` | `dev`, `pr-*`, `+dfsg*`, `~*` |
| Platform name | `Server.Platform.Name` | `X.Y.Z` after the product prefix | product prefix; empty never matches | none observed | missing version with a floor that has one |
| containerd | `Components[].Version` | `X.Y.Z` after mandatory `v` | `v` prefix | `-rc.N`, `-beta.N`, `-alpha.N` | `+unknown`, `.m`, no `v` |
| runc | `Components[].Version` | `X.Y.Z` | no `v`; commit free-form | `-rc.N`, legacy `-rcNN` | `+dev`, `+ds*`, `-dirty` |
| Compose | `docker compose version --short` | `X.Y.Z` | no `v` | `-rc.N`, `-alpha.N`, `-beta.N` | `dev` |
| macOS | `kern.osproductversion` | `X[.Y[.Z]]`, padded | none; `ProductVersionExtra` reported, not compared | none | anything else |
| Ubuntu, Debian release | `VERSION_ID` | `X[.Y[.Z]]`, padded | `ID` | none | `rolling`, missing |
| Kernel | `KernelVersion`, `os.release()` | per grammar above | flavour, `deb<N>`, localversion | `-rcN` | `+`, `-dirty`, `-N-g<sha>`, no grammar |

### What changes against the current parser

- `versionAdmitted` already does the right thing for Engine, CLI, runc, Compose and containerd, including the matched `v` rule; it should additionally classify pre-release suffixes as a reportable reason rather than falling through as unparseable.
- `kernelAdmitted` requires equal component counts and has no notion of Debian's `+deb13[.serial]`; it would refuse `7.0-linuxkit` and `6.12.120+deb13.1-cloud-amd64`. Replace with the three grammars and zero padding.
- No floor comparison exists yet for `host.release`; the profile validator already admits one to three components, so the new compare must pad.
- `src/cli/main.ts` compares `Bun.version` for equality; replace with a validated `>=X.Y.Z` floor, and never call `Bun.semver.satisfies` with an unvalidated range.
- `platformAdmitted` needs no change.

## Limitations

Bun canary output, Debian and Ubuntu distro-built Docker component output, and Debian ABI serial strings were taken from source and packaging rules, not observed on running systems. The Ubuntu kernel wiki was unavailable on the research date; cloud-kernel ABI numbering is evidenced from Launchpad versions only. Apple publishes no Darwin-to-macOS mapping table; the mapping above comes from release manifests, xnu tags and one measured host. Whether Background Security Improvements change `sw_vers` output on macOS 26.1 or later is undocumented.
