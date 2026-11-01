# Native platform experiments

This subset of the compatibility gate executes the frozen rendering and tooling fixtures on native Intel and Apple Silicon macOS 15, Ubuntu 24.04 and Ubuntu 26.04, with both Linux architectures. It records actual host/runtime identity before running fixtures. The bootstrap installs exactly the release floor Bun named in `scripts/bun-floor.json`, the one record that also carries each platform's archive hash from that release's official `SHASUMS256.txt`; `tests/ci` keeps the record equal to `package.json` `engines.bun`. Archive bytes are verified before executing the known binary, and a runtime reporting another version fails with "installed Bun differs from the release floor". The bootstrap rejects an existing runtime destination, wrong OS/architecture, Rosetta translation or unverified Mac CPU identity. It queries the current Python process through libc sysctlbyname with errno preserved. Following [Apple's documented translation check](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment), only ENOENT means an absent translation key establishes native execution. Other query errors fail host identity verification. Successful queries must return an integer 0 or 1 with the expected buffer size; 1 rejects translated execution. The CPU type must still match the requested architecture.

The [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the selected standard runner labels. Runner images are updated by GitHub; their actual image identifiers and OS/kernel versions are evidence, not immutable release inputs. These jobs do not install Docker on macOS or imply that its Docker runtime has been verified. The adjacent [distribution fixtures](../distro-fixtures/README.md) execute Debian and Arch userspaces. Native Linux restrictions run in the separate [runtime probe](../runtime-probe/README.md).

Run the bootstrap with an explicitly owned disposable destination, then execute the adjacent fixture commands using the resulting Bun binary. For example, on native macOS Intel:

```sh
python3 experiments/compatibility/platforms/bootstrap.py --system Darwin --architecture x86_64 --out "$FLEUR_PLATFORM_RUNTIME"
```

The CI workflow runs frozen installs, strict types, both lint engines, production browser build, unit checks and two pinned Chromium runs. Tooling failures remain failures. Browser OS dependency provisioning is explicit on disposable Linux runners. A passing subset cannot close the aggregate gate. All six native jobs passed at `ba3769df6debc468c6ff7a8ccacad52fdf30f2ee` in [run 38455482128](https://github.com/hazeion/fleur/actions/runs/38455482128). Actual macOS was 15.7.9 on both CPU families; Ubuntu versions were 24.04 and 26.04 on amd64 and arm64. Native CPU/translation checks passed before checksum-verified Bun execution. Build, strict types, both lint engines, unit checks, frozen tooling and three Chromium cases on each of two runs passed. See the [durable matrix and archive digests](../evidence.md). These results supersede the earlier unverified local translation observation; no macOS Docker installation/readiness claim follows.

## Bootstrap regression

Run the public CLI regression with synthetic OS-query responses:

```sh
python3 experiments/compatibility/platforms/test_bootstrap.py
```

On October 13, 2026, the regression first reproduced four false-native results for permission denial, malformed positive and negative integers, and malformed buffer size. After the fix, all seven cases passed, including native-zero and ENOENT positive controls and translated-process rejection. These tests deliberately prevent archive acquisition; no downloaded artifact verification or runtime execution is simulated as passing. The actual local current-process query returned 0. This isolated observation does not establish the CPU identity, downloaded runtime, platform fixture results or release support. Native CI jobs must run the corrected bootstrap before their evidence is accepted.
