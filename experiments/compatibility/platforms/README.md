# Native platform experiments

This subset of the compatibility gate executes the frozen rendering and tooling fixtures on native Intel and Apple Silicon macOS 15, Ubuntu 24.04 and Ubuntu 26.04, with both Linux architectures. It records actual host/runtime identity before running fixtures. Exact Bun 1.4.3 archive hashes come from its official release metadata. Archive bytes are verified before executing the known binary. The bootstrap rejects an existing runtime destination, wrong OS/architecture, Rosetta translation or unverified Mac CPU identity.

The [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists the selected standard runner labels. Runner images are updated by GitHub; their actual image identifiers and OS/kernel versions are evidence, not immutable release inputs. These jobs do not install Docker on macOS or imply that its Docker runtime has been verified. Debian, an exact Arch snapshot and complete restricted execution remain separate obligations.

Run the bootstrap with an explicitly owned disposable destination, then execute the adjacent fixture commands using the resulting Bun binary. For example, on native macOS Intel:

```sh
python3 experiments/compatibility/platforms/bootstrap.py --system Darwin --architecture x86_64 --out "$FLEUR_PLATFORM_RUNTIME"
```

The CI workflow runs frozen installs, strict types, both lint engines, production browser build, unit checks and two pinned Chromium runs. Tooling failures remain failures. Browser OS dependency provisioning is explicit on disposable Linux runners. A passing subset cannot close the aggregate gate. Native platform execution results will be recorded after the jobs run.
