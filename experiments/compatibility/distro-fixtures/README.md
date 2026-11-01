# Frozen distribution userspace fixtures

This probe runs the existing locked rendering and tooling experiments inside Debian 13 amd64/arm64 or Arch amd64 containers, on a matching native Linux Docker host. It rejects other host architectures and Docker server architectures before building. These are container userspace results on the recorded host kernel. They do not prove native Debian/Arch installation, Docker setup on either distribution, macOS Docker, or complete restricted application execution.

## Inputs and checks

Official Docker Library metadata observed October 13, 2026 established these immutable image manifests:

| Target | Base manifest | Observed index |
|---|---|---|
| Debian 13 amd64 | `debian@sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483` | `sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f` |
| Debian 13 arm64 | `debian@sha256:a2ca65377c251208de42e1a2722cb949211236c161b634f6f3663754e2d06850` | Same Debian index |
| Arch amd64 | `archlinux@sha256:363129b67b2bc6c5a634f8fb4961a7e2eba213a2ec075d159127b1260290a722` | `sha256:3c64b538588416593f69a1aebd2f2ec0f2541b29159f32556fa7def2167147a0` |

Debian package sources are the signed [Debian snapshot archive](https://snapshot.debian.org/) and security archive at `20261012T000000Z`, with only trixie and trixie-security main. HTTP lets the minimal base obtain certificate authorities through APT's signed metadata and package checksums; package signature verification remains enabled. Expired historical metadata is explicitly allowed. No package source falls back to a moving mirror. Arch uses the [Arch Linux Archive](https://archive.archlinux.org/repos/2026/10/12/) snapshot of October 12, 2026, with pacman's package signature checking unchanged. Each image records its exact installed package/version inventory.

Provisioning occurs inside the owned disposable image. The build context copies only the four relevant experiment directories, excluding installed dependencies and generated output. Containers receive no host mounts, repository credentials, Docker socket or secrets. They drop Linux capabilities and forbid privilege escalation. Networking permits downloading checksum-verified Bun and locked dependency/browser archives; this probe does not claim application-network restriction.

The adjacent platform bootstrap verifies the release floor Bun archive checksum and runtime version from `scripts/bun-floor.json`, which the driver copies into the build context. Both tooling runs preserve its locked Drizzle source patch and provenance. Rendering runs frozen installs, strict types, production build, both full fixture lint engines, unit checks twice and browser checks twice. Playwright 1.64.0 selects its package-pinned Chromium. Browser identity records the actual default browser launch version and the full Chromium executable hash plus browser revision metadata. Arch tries that browser directly against explicitly installed snapshot libraries. If it fails, the result fails; a Debian/Ubuntu browser wrapper has not been implemented or verified by this probe.

## Running and evidence

Use a new explicitly owned evidence directory outside the checkout:

```sh
python3 experiments/compatibility/distro-fixtures/run.py --target debian-amd64 --out "$FLEUR_DISTRO_EVIDENCE"
```

Other exact targets are `debian-arm64` and `arch-amd64`. The driver emits JSON and exits 0 only when every fixture and cleanup succeeded. Missing Docker, wrong host architecture, failed builds, missing browser libraries, timeouts and test failures exit 2. `driver.json` records the host/kernel, Docker version, base digest, built image ID and subprocess exit statuses. Container evidence includes OS identity, installed package versions, fixture statuses and command output. Every aggregate report keeps `v1_gate_passed` false.

The driver creates randomly named resources and validates ownership labels before removal. Failed builds may leave Docker's ordinary shared build cache; the driver does not prune unrelated cache. No development database or host data is touched.

The public CLI prerequisite regression must reject a wrong native architecture before invoking Docker or downloading artifacts:

```sh
python3 experiments/compatibility/distro-fixtures/test_cli.py
```

The first run failed because the driver did not yet exist. After implementation, the regression passed on the local macOS machine. Syntax checks also passed. Docker was unavailable on the local host, so those initial controls established reporting only. All three actual hosted fixtures later passed in [run 38455482128](https://github.com/hazeion/fleur/actions/runs/38455482128). The exact Debian 13.7 and Arch base/package snapshot identities, browser version/digest and built image IDs are retained in the [durable evidence record](../evidence.md). Both tooling and browser runs passed twice for each userspace. The tested direct Arch browser path uses package-pinned Chromium 156.0.8078.4, revision 1248, with snapshot libraries and Bun-launched workers; it needs no separate Node runtime or fallback wrapper. These remain userspace results on Ubuntu, not native distribution kernel/Docker installation evidence.

## Cleanup launch regression

A simulated fixture timeout followed by an unavailable Docker executable during container ownership inspection originally aborted cleanup and suppressed the final JSON report. The public CLI regression reproduced that failure before the fix. The process wrapper now records the launch error class, continues ownership-checked cleanup of the other resource and writes the final failed report. It excludes private exception text from launch-error evidence. Both prerequisite and cleanup regressions passed after the fix. The synthetic process boundary establishes reporting behavior only, without claiming any actual Docker execution.

## Bounded Arch archive transport

Run 38489592848 failed while pacman fetched `extra.db` from the unchanged October 12 archive. Its built-in downloader reported less than one byte per second over its ten-second low-speed window. The pinned OCI image had downloaded successfully. The failure occurred before package installation or fixture execution.

Provisioning now uses pacman's documented [XferCommand](https://man.archlinux.org/man/pacman.conf.5.en) with the adjacent `arch-download.sh`. The downloader uses [curl's transient retry policy](https://curl.se/docs/manpage.html#--retry), with at most three attempts on the same URL, a 15-second connection timeout, a 120-second maximum per attempt, two-second retry delays and a 300-second window for starting retries. The three attempts can take at most 364 seconds including both delays. The existing 1,200-second Docker build timeout also bounds the overall provisioning operation. Permanent missing files fail immediately. Failed partial output is removed. Pacman still validates package checksums and signatures and performs the `.part` rename. Package transactions never retry, and the date, image digest, repositories and signature settings stay fixed.

The public downloader regression first failed before the downloader existed. The completed suite exercises a real local HTTP service: a transient 503 followed by exact successful bytes, a 404 with one attempt, and persistent 503s that stop after three attempts. All three cases and both driver regressions passed locally. The local curl version was 8.7.1; native container execution will establish behavior with its actual curl version.

Three bounded downloads of the exact archive database returned the same 8,893,798 bytes with SHA-256 `6257fcc963adfd914f299884eae839f3ef139daf7c9c4248257d9c959029e849`. Independent observations took 9.525 and 5.691 seconds; the implemented downloader took 8.316 seconds. These measurements establish current resource availability and transfer identity. They do not prove native Docker provisioning or replace the pending CI fixture run.

```sh
python3 -m unittest discover -s experiments/compatibility/distro-fixtures -p 'test_*.py'
```
