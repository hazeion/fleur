# Native platform experiments

This subset of the compatibility gate executes the frozen rendering and tooling fixtures on native Intel and Apple Silicon macOS 15, Ubuntu 24.04 and Ubuntu 26.04, with both Linux architectures. It records actual host/runtime identity before running fixtures. Exact Bun 1.4.3 archive hashes come from its official release metadata. Archive bytes are verified before executing the known binary. The bootstrap rejects an existing runtime destination, wrong OS/architecture, Rosetta translation or unverified Mac CPU identity. It queries the current Python process through libc sysctlbyname with errno preserved. Following [Apple's documented translation check](https://developer.apple.com/documentation/apple-silicon/about-the-rosetta-translation-environment), only ENOENT means an absent translation key establishes native execution. Other query errors fail host identity verification. Successful queries must return an integer 0 or 1 with the expected buffer size; 1 rejects translated execution. The CPU type must still match the requested architecture.

The [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the selected standard runner labels. Runner images are updated by GitHub; their actual image identifiers and OS/kernel versions are evidence, not immutable release inputs. These jobs do not install Docker on macOS or imply that its Docker runtime has been verified. Debian, an exact Arch snapshot and complete restricted execution remain separate obligations.

Run the bootstrap with an explicitly owned disposable destination, then execute the adjacent fixture commands using the resulting Bun binary. For example, on native macOS Intel:

```sh
python3 experiments/compatibility/platforms/bootstrap.py --system Darwin --architecture x86_64 --out "$FLEUR_PLATFORM_RUNTIME"
```

The CI workflow runs frozen installs, strict types, both lint engines, production browser build, unit checks and two pinned Chromium runs. Tooling failures remain failures. Browser OS dependency provisioning is explicit on disposable Linux runners. A passing subset cannot close the aggregate gate. Native platform execution results will be recorded after the jobs run.

## Bootstrap regression

Run the public CLI regression with synthetic OS-query responses:

```sh
python3 experiments/compatibility/platforms/test_bootstrap.py
```

On October 13, 2026, the regression first reproduced four false-native results for permission denial, malformed positive and negative integers, and malformed buffer size. After the fix, all seven cases passed, including native-zero and ENOENT positive controls and translated-process rejection. These tests deliberately prevent archive acquisition; no downloaded artifact verification or runtime execution is simulated as passing. The actual local current-process query returned 0. This isolated observation does not establish the CPU identity, downloaded runtime, platform fixture results or release support. Native CI jobs must run the corrected bootstrap before their evidence is accepted.
