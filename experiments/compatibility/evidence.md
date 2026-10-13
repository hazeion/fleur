# Executed compatibility evidence

Evidence date: October 13, 2026. [PR #39](https://github.com/hazeion/fleur/pull/39) merged with all fifteen checks successful in [run 38455482128](https://github.com/hazeion/fleur/actions/runs/38455482128), tested commit `ba3769df6debc468c6ff7a8ccacad52fdf30f2ee`. This record preserves sanitized identities from its artifacts, which expire after seven days. Digests identify those observed bytes/builds; they are not a completed Fleur release or production artifact.

## Gate status

Executed: SSR/island refresh and browser artifact boundaries; native all-thread restriction and syscall/descriptor controls on both Linux architectures; one-CPU/512-MiB/64-PID cgroup enforcement; registered broker authority; real disposable PostgreSQL transactions/cancellation/rollback/commit-unknown cases; Microsoft compiler/inferred internal types and separate lint engines; native macOS/Ubuntu and Debian/Arch userspace fixtures.

Still required before closing #23: inspect the effective restricted container configuration for absence of host secrets/socket/database credentials/network/writable host mounts, and execute a CPU-busy restricted worker deadline test alongside healthy work. Follow-up commit `b2b4905` expands both lint engines to all five positive tooling TypeScript sources. Its two CLI regressions demonstrated red before the fix, then passed twice; the actual complete frozen Bun runner passed afterward. This follow-up awaits the next CI run. No new pass is attributed to the older commit. Independent review and final CI remain required. Dependent implementation stays blocked meanwhile.

The internal compatibility fixtures do not implement the later Fleur API, generic admission compiler, Docker installer, lifecycle, packed CLI, production artifact or release support. Experimental Rust remains unavailable until exact upstream/package equivalence succeeds. No alternate compiler fallback exists.

## Native host matrix

Every row passed checksum/native identity before Bun execution, frozen rendering build/types/independent lint/unit checks, three browser cases twice, and the complete internal tooling runner.

| Native target | Actual OS | Kernel | Runner image | Process identity |
| --- | --- | --- | --- | --- |
| macos-15 | macOS 15.7.9 | `24.6.0` | `20260907.0337.1` | arm64; CPU 16777228; translated 0 |
| macos-15-intel | macOS 15.7.9 | `24.6.0` | `20260824.0482.1` | x86_64; CPU 7; translated 0 |
| ubuntu-24.04 | Ubuntu 24.04 | `6.17.0-1022-azure` | `20261004.327.1` | x86_64 |
| ubuntu-24.04-arm | Ubuntu 24.04 | `6.17.0-1022-azure` | `20261004.142.1` | arm64 |
| ubuntu-26.04 | Ubuntu 26.04 | `7.0.0-1012-azure` | `20260927.149.1` | x86_64 |
| ubuntu-26.04-arm | Ubuntu 26.04 | `7.0.0-1012-azure` | `20260927.135.1` | arm64 |

Bun is `1.4.3+c6da4a4d3` on every native target. Bootstrap verified the official archive bytes and recorded the actual executable hashes:

| Artifact | Archive SHA-256 | Executed binary SHA-256 |
| --- | --- | --- |
| Darwin x86_64 | `62660e6438eb872278877acca77e1152d5d031324df368d4a81b428211489d2d` | `c2a945a9d33f9088b32ac3550d1d1fd485a7fc10d71c66f91ef0d33b41cefa7c` |
| Darwin arm64 | `80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403` | `28c7dd0a06916aba284d570ef44a2d70e9c538eaf2ba58dfe0910525563b3f79` |
| Linux x86_64 | `3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18` | `7ce7d6b654eddeec20afddf2396317fba6dc19ab52788a27e894e1806bf8f24b` |
| Linux arm64 | `efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21` | `029ece746ac9f970c76d8f48bdd1b1d0c52f3636b74d19f546f5e7c1165c0abe` |

## Frozen package and browser pins

Main and independent-lint dependency graphs use checked-in Bun lockfiles with integrity records. Drizzle uses the exact source-backed declaration-only repair and provenance checks; its runtime bytes are unchanged.

| Package/tool | Verified version |
| --- | --- |
| Bun runtime and types | 1.4.3 |
| Microsoft TypeScript default | 7.0.2 |
| Preact / render-to-string | 11.0.1 / 6.8.0 |
| Vite | 8.3.4 |
| Zod | 4.6.7 |
| tRPC server/client | 11.19.0 |
| Drizzle ORM | 0.45.4 plus locked declaration patch |
| Internal declaration peers gel / mysql2 | 2.2.1 / 3.24.6 |
| Oxlint | 1.87.0 |
| ESLint / typescript-eslint | 10.12.0 / 8.71.2 |
| Independent ESLint TypeScript engine | 6.0.3 |
| Playwright Test | 1.64.0 |
| Chromium / headless-shell package revision | 156.0.8078.4 / 1248 |
| Native GCC | Ubuntu 13.3.0-6ubuntu2~24.04.1 |
| Linux Docker Engine | 28.0.4 |
| PostgreSQL | 18.6 |

Bun launches the Playwright CLI, test worker and fixture server. There is no separate Node browser prerequisite. GitHub action infrastructure's own Node runtime and Bun's `node:` compatibility imports do not create a Fleur or browser Node prerequisite.

## Debian and Arch userspaces

The three rows ran on matching native Ubuntu 24.04.5 hardware, kernel `6.17.0-1022-azure`, with Docker 28.0.4. Debian reported 13.7/trixie. Arch's base reported VERSION_ID `20261011.0.609700`; installed packages came only from the signed archive snapshot of October 12, 2026. Debian used signed trixie/trixie-security snapshots at `20261012T000000Z`. No moving mirror fallback was used. Both tooling runs, both unit runs, both browser runs, build/types/lint and ownership-checked cleanup passed in every row.

| Userspace | Immutable base manifest | Observed built image ID |
| --- | --- | --- |
| debian-amd64 | `sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483` | `sha256:2271f154fb8f5d8adc818e77019a685e9dc248c1303fe2eaec2e1b3464c49ce8` |
| debian-arm64 | `sha256:a2ca65377c251208de42e1a2722cb949211236c161b634f6f3663754e2d06850` | `sha256:23fd94e10fef3495e12ae73c5e73fc3921f280d08bd43756767aaaf8b962bbb7` |
| arch-amd64 | `sha256:363129b67b2bc6c5a634f8fb4961a7e2eba213a2ec075d159127b1260290a722` | `sha256:c3e21719f4bc9a77e9eeed793d3ecdbc1832cbc29444307d6f7f48cdd707fe92` |

Observed OCI indices: Debian `sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f`; Arch `sha256:3c64b538588416593f69a1aebd2f2ec0f2541b29159f32556fa7def2167147a0`.

The tested Arch browser path is direct Playwright-pinned Chromium against its snapshot libraries. Actual default launch returned 156.0.8078.4; no wrapper or alternate browser fallback was used. Full Chromium executable SHA-256 was `377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025` on amd64 and `2b3a2bb9c4308ce74cb680dcd50305cfae1f79589305dc92b993f876b5a94f65` on arm64. These binary hashes describe the full executable; browser tests use Playwright's default headless launch.

These are userspace/runtime/browser results on an Ubuntu host kernel. They do not establish native Debian/Arch kernel or Docker installation support, macOS Docker readiness, or the later release matrix.

## Restricted native build identities

Both probes ran on native Ubuntu 24.04.5 with the recorded kernel and Docker version above. Both frozen compiler pins verified before compilation; helper/pressure binaries had the required ELF64/little-endian machine identity. Actual image IDs and build hashes:

| Architecture | Bun base manifest | GCC executable SHA-256 | Helper SHA-256 | Built image ID |
| --- | --- | --- | --- | --- |
| amd64 | `oven/bun@sha256:c017a211c49a21adc0e49dda7b60ac8112887c3d9465e01427f434ed107c830e` | `1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26` | `39cff765bb13ab8c99321e135a631906ab8fe149fb50fe79aecc39afa878e089` | `sha256:f195b506e88560fada0a89e59b95d17c1f9830a194f412423919bb0d1d1f7c13` |
| arm64 | `oven/bun@sha256:bf9d5b1f01be2de7cec5aa6e3977e8848f7ab9a307c6c3a8af7a50a27e609023` | `a20520ee21543f243d40636a9181a142c45ecd989de31ab86b99a8ea5ada870d` | `6805d0f8593e6e6ba7065eb91de9cff62851c427f6b1d13f0488208d79e993df` | `sha256:fe1e977b8ecb6b36fdb79d4109ce8e6cae679e78e0331520ae993573ce6e9c92` |

Both reports recorded exact-zero TSYNC, all 24 architecture-labelled controls denied, unrelated inherited descriptors closed, Bun file access denied, Preact rendering and registered stdio reply successful, and the preexisting thread witness denied. The trusted host independently observed five worker TIDs each with no-new-privileges, seccomp mode 2 and exactly one filter before broker acknowledgment. The actual CPU/memory/PID pressure checks and owned cleanup passed. The ARM64 diagnostic run passed the unchanged 30-second worker bound; it does not identify the earlier stall's cause.

PostgreSQL's acquired OCI index was `sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`. Its owned amd64 database image resolved to:
`sha256:29754c7520f4b9654cf8ff98e19ac73b88e255c3a53f6236ebe9d52249bb6df3`. Server identity verified PostgreSQL 18.6 before fixture writes. The complete database cases ran twice; every required check passed, including real restricted worker/broker exchange, strict types, both lint engines and bundle construction. Cleanup was verified. No development or production data was supplied.

## Verification commands

Run from the repository root unless a working directory is named. Set each variable to an explicitly owned disposable destination or verified executable. Python and native GCC are experiment tools, not application runtime prerequisites. Docker must already be available for database/native/distro commands. Their explicit image/package downloads are experiment provisioning; production startup acquisition is a later artifact contract.

| Operation | Command | Actual output and exit contract |
| --- | --- | --- |
| Checksum/native bootstrap | `python3 experiments/compatibility/platforms/bootstrap.py --system Linux --architecture x86_64 --ubuntu 24.04 --out "$FLEUR_PLATFORM_RUNTIME"` | One JSON object with host/runtime identity; 0 on verified success, 1 on failure, argparse 2 for invalid invocation. Rejects an existing destination. For macOS use `--system Darwin`, x86_64 or arm64, without `--ubuntu`. |
| Internal tooling | `python3 experiments/compatibility/tooling/run.py --bun "$FLEUR_EXPERIMENT_BUN"` | JSON check report; 0 only when expected exits and intended negative diagnostics match, 1 for check failures; argparse 2 for invalid invocation/runtime mismatch. Uses a temporary frozen dependency graph. |
| Rendering dependencies | In `experiments/compatibility/rendering`: `bun install --frozen-lockfile`; in its `lint` directory run the same command | Bun install output and native exit status; no JSON result envelope. |
| Pinned browser acquisition | In rendering: `bun ./node_modules/@playwright/test/cli.js install chromium` | Playwright provisioning logs/native exit status. Linux CI explicitly adds `--with-deps`; distro images provide snapshot libraries. |
| Rendering verification | In rendering: `bun run build`, `bun run types`, `bun run lint`, `bun run test`, then `bun run browser` twice | Native build/compiler/lint/test logs and exit status. Separate steps fail on error; three browser cases per run. |
| Owned PostgreSQL/broker | `python3 experiments/compatibility/database-broker/run.py --bun "$FLEUR_EXPERIMENT_BUN"` | One bounded/redacted JSON report; 0 only for required checks and cleanup success, 1 on failure, argparse 2 for invalid invocation. Complete cases twice by default; subset reports remain diagnostic. |
| Native restriction/resources | `python3 experiments/compatibility/runtime-probe/run.py --architecture amd64` | JSON including worker/resource/cleanup evidence; 0 on complete bounded probe success, 1 on failure, argparse 2 on invalid invocation. Use arm64 only on a matching native host. |
| Distribution userspace | `python3 experiments/compatibility/distro-fixtures/run.py --target debian-amd64 --out "$FLEUR_DISTRO_EVIDENCE"` | JSON stdout and owned evidence directory; 0 only for fixtures and cleanup success, 2 on prerequisite/check failure. Other targets: debian-arm64 and arch-amd64. |
| Read-only isolation inventory | `python3 experiments/compatibility/isolation/preflight.py` | One JSON diagnostic, always exit 2 deliberately; never certifies isolation or evaluates application code. |
| Driver regressions | `python3 -m unittest discover -s experiments/compatibility/<experiment> -p 'test_*.py'` | unittest logs/native exit status; use tooling, platforms, isolation, distro-fixtures or database-broker. Native probe uses its documented warning-as-error invocation. |

These experiment commands do not pretend to implement the future Fleur catalog or JSON formatVersion 1. The [PR-only workflow](../../.github/workflows/compatibility.yml) is the executable CI catalog for its runner matrix, pinned actions, provisioning, commands, timeouts and retained artifacts.
