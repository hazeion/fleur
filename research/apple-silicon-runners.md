# Docker on GitHub-hosted Apple Silicon macOS runners, and the alternatives

Research ticket: [#161](https://github.com/hazeion/fleur/issues/161) (map [#160](https://github.com/hazeion/fleur/issues/160)).
Date: 2026-11-09. Prices and runner labels in this area change often; every figure below carries the date it was read.

## Question

Can any Docker product (Docker Desktop, Colima, Lima, Podman machine, OrbStack) run Linux containers on GitHub-hosted Apple Silicon macOS runners (`macos-15`, `macos-26`, `macos-*-xlarge`), so that Fleur's doctor can produce a genuine measured readiness row for `darwin-arm64`? If not, what is the cheapest credible path to such a row?

## Summary answer

No. Every Docker product on macOS runs its Linux engine inside a virtual machine, and GitHub-hosted arm64 macOS runners cannot create one. GitHub documents this as a product limitation on both its standard and larger-runner pages: "Nested-virtualization is not supported due to the limitation of Apple's Virtualization Framework" (read 2026-11-09). On 2026-01-08 GitHub staff closed the latest request with "there's nothing we can do yet. The feature is still unavailable due to reasons beyond our control." The root cause is structural rather than a chip generation: GitHub runners are themselves macOS guest VMs, and Apple's Virtualization framework exposes nested virtualization only on `VZGenericPlatformConfiguration` (Linux and generic guests, M3 or later, macOS 15 or later); `VZMacPlatformConfiguration` (macOS guests) has no such property. A hosted runner upgraded from M1/M2 Pro to M4 would therefore still not run Docker, and third-party macOS runner vendors confirm the same limit (WarpBuild: "MacOS runners do not support nested virtualization and cannot run docker"). Intel runners (`macos-15-intel`, `macos-26-intel`) keep Hypervisor.framework and are the only hosted macOS path where Docker works, which is why Fleur's Intel row could be measured.

A genuine `darwin-arm64` measured row therefore needs bare-metal Apple Silicon: an owned Mac, or a rented Mac mini with the Fleur doctor run on it directly (the way the Intel row was measured on the development machine). The cheapest credible rental is a Scaleway Mac mini M4 at €0.22/hour with a 24-hour minimum (about €5.30 per measurement day), followed by AWS `mac2.metal` (M1, about $0.65/hour, 24-hour minimum, about $15.60 per day) and MacStadium monthly plans from $109 (M2) or $149 (M4). GitHub's own guidance says self-hosted runners "should almost never be used for public repositories", and Fleur is public, so the rented host should be driven manually or by a Fleur-owned script over SSH, not registered as a persistent self-hosted runner.

## Findings

### 1. GitHub-hosted macOS runner labels, hardware and prices

Source: [docs.github.com, "Supported runners and hardware resources"](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [actions/runner-images README](https://github.com/actions/runner-images/blob/main/README.md), read 2026-11-09; prices from [docs.github.com, "Actions runner pricing"](https://docs.github.com/en/billing/reference/actions-runner-pricing), read 2026-11-09.

| Label(s) | Architecture and chip | vCPU / RAM / SSD | Billing SKU and rate (private repos) |
| --- | --- | --- | --- |
| `macos-latest`, `macos-15`, `macos-26`, `xcode-27` (preview) | arm64, documented as M1 | 3 / 7 GB / 14 GB | `actions_macos`, $0.062 per minute |
| `macos-15-intel`, `macos-26-intel` | Intel x64 | 4 / 14 GB / 14 GB | `actions_macos`, $0.062 per minute |
| `macos-latest-large`, `macos-15-large`, `macos-26-large` | Intel x64, larger runner | 12 / 30 GB / 14 GB | `macos_l`, $0.077 per minute |
| `macos-latest-xlarge`, `macos-15-xlarge`, `macos-26-xlarge`, `xcode-27-xlarge` | arm64, M2 Pro (larger-runner page says "M2"), 8 GPU cores | 5 / 14 GB / 14 GB | `macos_xl`, $0.102 per minute |
| `macos-14` (arm64), `macos-14-large`, `macos-14-xlarge` | retired | | "All macOS 14 images retired from GitHub Actions on November 2, 2026" (runner-images README) |

Notes:

- The XLarge SKU moved from a 6-core M1 to a 5 vCPU M2 Pro on 2025-07-17 at "$0.16/min, the same as the previous XLarge SKU" ([GitHub changelog, 2025-07-16](https://github.blog/changelog/2025-07-16-github-actions-now-offers-m2-pro-powered-hosted-runners-in-public-preview/)). The pricing reference page read on 2026-11-09 lists `macos_xl` at $0.102 per minute, so the rate has since been cut; the reference page is authoritative for current billing.
- macOS 26 labels became generally available on 2026-02-26 ([GitHub changelog](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)).
- No GitHub-hosted macOS runner on M3 or newer hardware exists or is announced as of 2026-11-09 (runner-images README, larger-runners page, changelog search).
- "GitHub hosts macOS runners in Azure data centers" and "each GitHub-hosted runner is a new virtual machine (VM) hosted by GitHub" ([docs.github.com, "GitHub-hosted runners" concept page](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners), read 2026-11-09). GitHub does not document which hypervisor it uses for macOS.

### 2. Free tier, included usage and concurrency

Sources: [docs.github.com, "GitHub Actions billing"](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [larger-runners reference](https://docs.github.com/en/actions/reference/runners/larger-runners) and [Actions limits](https://docs.github.com/en/actions/reference/limits), all read 2026-11-09.

- Standard runners (including `macos-15`, `macos-26`, `macos-*-intel`) in public repositories "are free and do not reduce included usage". Fleur is a public repository, so its existing `macos-15` and `macos-15-intel` native-fixture jobs cost nothing.
- Private repositories draw from included compute usage, now expressed as money rather than minutes: GitHub Free $12 per month, Pro $18, Free for organizations $12, Team $18, Enterprise Cloud $300. At $0.062 per minute, $12 covers about 193 standard macOS minutes.
- Larger runners (`-large`, `-xlarge`) are never free: "Larger runners are not free for public repositories"; they require a credit card on file and a spending limit above zero, and they draw from included usage only on Team and Enterprise Cloud.
- Concurrency (standard and larger runners share the macOS cap): Free 20 total jobs, 5 macOS; Pro 40 / 5; Team 60 / 5; Enterprise 500 / 50.
- Self-hosted runners "are free to use with GitHub Actions, but you are responsible for the cost of maintaining your runner machines" ([self-hosted runners concept page](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners), read 2026-11-09).

### 3. Nested virtualization on hosted arm64 macOS runners

GitHub's statements:

- Standard runners page, "Limitations for arm64 macOS runners": "Nested-virtualization is not supported due to the limitation of Apple's Virtualization Framework" (read 2026-11-09). The same sentence appears under "Limitations for macOS larger runners".
- [actions/runner-images#9460](https://github.com/actions/runner-images/issues/9460) (opened and closed 2024-03-06): Docker Desktop and Colima both fail on `macos-14` and `macos-13-xlarge`; `qemu-system-aarch64 -accel hvf` returns `HV_UNSUPPORTED` and `sysctl kern.hv_support` reports `unknown oid`. GitHub staff: "it's an architectural issue. We can do nothing about it ... stick to the Intel based agents in case of macOS."
- [actions/runner-images#9254](https://github.com/actions/runner-images/issues/9254), staff comment 2024-03-10: "it is not a GitHub restriction, Apple does not support nested virt on M1 CPU gen entirely".
- [actions/runner-images#12933](https://github.com/actions/runner-images/issues/12933), staff comment 2025-09-11: hardware-accelerated virtualization exists on Linux runners (KVM, since 2024-04-02) but "this feature is still not available for macos runners".
- [actions/runner-images#13505](https://github.com/actions/runner-images/issues/13505) (opened 2026-01-08 citing Apple's EL2 nested-virtualization support in Hypervisor.framework), closed the same day by GitHub staff: "there's nothing we can do yet. The feature is still unavailable due to reasons beyond our control. However, we will continue to communicate with our upstream vendors."

Apple's constraints, read 2026-11-09 from the developer documentation data endpoints:

- [`VZGenericPlatformConfiguration.isNestedVirtualizationSupported`](https://developer.apple.com/documentation/virtualization/vzgenericplatformconfiguration/isnestedvirtualizationsupported): introduced in macOS 15.0; "Nested virtualization is available for Mac with the M3 chip, and later." The class is "The platform configuration for a generic Intel or ARM virtual machine", which is the Linux-guest configuration.
- [`VZMacPlatformConfiguration`](https://developer.apple.com/documentation/virtualization/vzmacplatformconfiguration) ("The platform configuration for booting macOS on Apple silicon") lists only `auxiliaryStorage`, `hardwareModel` and `machineIdentifier`; it has no nested-virtualization property, and the base class `VZPlatformConfiguration` has none either.
- Tart, the Virtualization-framework VM tool used by several CI vendors, states the same: nested virtualization is supported "only on M3 or M4 chips running macOS 15 (Sequoia) or later ... and only for Linux VMs" ([tart.run FAQ](https://tart.run/faq/), read 2026-11-09).

Consequence: a GitHub-hosted macOS runner is a macOS guest VM. Even on M3 or newer hosts, Apple's framework does not let a macOS guest create a nested VM, so Docker's Linux VM cannot start there. This is why the limitation outlasted the M1 generation and why the M2 Pro XLarge runner is equally affected (M2 is also below Apple's M3 floor).

### 4. Docker products examined

All read 2026-11-09. Each one needs a Linux VM or the Hypervisor framework on macOS, so each is blocked by section 3.

| Product | Mechanism on macOS (source) | Status on hosted arm64 runners |
| --- | --- | --- |
| Docker Desktop | "Current versions of Docker Desktop use the Apple Virtualization framework by default" ([Mac FAQs](https://docs.docker.com/desktop/troubleshoot-and-support/faqs/macfaqs/)); alternative Docker VMM is "a container-optimized virtual machine manager" ([Docker VMM](https://docs.docker.com/desktop/features/vmm/)). Docker documents no VM-in-VM or CI mode for Mac; its VDI guidance exists only for Windows. | Fails; reported in #9460 ("complains that the virtualization framework [is] not being enabled") |
| Colima | Lima VM with `vz` or `qemu` driver; template option `nestedVirtualization: false # (requires m3 mac and vmType vz)` ([embedded/defaults/colima.yaml](https://github.com/abiosoft/colima/blob/main/embedded/defaults/colima.yaml), latest release v0.10.3, 2026-06-04) | Fails; `-accel hvf` returns `HV_UNSUPPORTED` (#9460) |
| Lima | "Lima will use VZ by default on macOS (>= 13.5)" ([lima-vm.io vmtype](https://lima-vm.io/docs/config/vmtype/)); `nestedVirtualization` option in `templates/default.yaml` (latest release v2.3.0, 2026-11-06) | Same as Colima |
| Podman machine | "On Mac, each Podman machine is backed by a virtual machine" ([podman.io installation](https://podman.io/docs/installation)) | Blocked by the same VM requirement |
| OrbStack | "OrbStack uses a lightweight Linux virtual machine"; requires macOS 14+ ([OrbStack FAQ](https://docs.orbstack.dev/faq)) | Blocked by the same VM requirement |
| Apple `container` | "create and run Linux containers as lightweight virtual machines on your Mac ... supported on macOS 26" ([apple/container README](https://github.com/apple/container/blob/main/README.md)) | Blocked, and in any case not a Docker product row for Fleur's catalog |

QEMU without hardware acceleration (TCG software emulation) could in principle boot a Linux guest on these runners, but it would record a QEMU-emulated kernel and run far too slowly for Fleur's 60-second operation deadline; it would not be a credible measured row for a real Apple Silicon host and is not recommended.

### 5. Third-party hosted macOS runners

Read 2026-11-09. These vendors run newer chips but their macOS runners are also VMs, so the Apple constraint applies.

- WarpBuild: M4 Pro / M5 Pro hosts, `warp-macos-26-arm64-6x` at $0.08 per minute and `-12x` at $0.16; "MacOS runners do not support nested virtualization and cannot run docker" ([WarpBuild cloud runners docs](https://warpbuild.com/docs/ci/cloud-runners)).
- Depot: `depot-macos-26` on M4 (8 vCPU, 24 GB) at $0.08 per minute; the docs make no statement about Docker or virtualization ([Depot runner types](https://depot.dev/docs/github-actions/runner-types)). Nothing suggests it escapes the macOS-guest limit.
- Cirrus Runners: "macOS M4 Pro" at "$150 per month per concurrent Cirrus Runner"; no Docker statement; the site carries a banner "we're joining OpenAI to work on Agent Infrastructure" ([cirrus-runners.app](https://cirrus-runners.app/)), so continuity is uncertain.
- FlyCI documents "nested virtualization is currently not supported on its macOS runners" (search result summary, not independently fetched).

None should be assumed to produce a genuine row without a vendor statement that its macOS runners are bare metal or support nested virtualization.

### 6. Bare-metal Apple Silicon for a self-driven measurement

All prices read 2026-11-09; rented Macs are bare metal, so Docker Desktop runs natively on them.

| Provider | Offer | Price | Minimum | Source |
| --- | --- | --- | --- | --- |
| Scaleway (Paris) | Mac mini M4-S (M4, 16 GiB, 256 GB) | €0.22 per hour, €149 per month | 24 hours: "The minimum lease period for Apple silicon is 24 hours due to licensing restrictions" | Price from web search of scaleway.com/en/pricing/apple-silicon (the page refuses automated fetches, so the figure is from search snippets and should be reconfirmed before purchase); minimum and offers from the [Scaleway docs FAQ](https://github.com/scaleway/docs-content/blob/main/pages/apple-silicon/faq.mdx) and [datasheet](https://github.com/scaleway/docs-content/blob/main/pages/apple-silicon/reference-content/apple-silicon-datasheet.mdx) (M1-M, M2-M, M2 Pro-L, M4-S, M4-M, M4 Pro-XL) |
| Scaleway | Mac mini M4-M (32 GiB) | €0.29 per hour, €199 per month | 24 hours | same |
| AWS EC2 Mac (Dedicated Hosts) | `mac2.metal` (M1, 8 cores, 16 GB) | about $0.65 per hour on demand | "minimum host allocation and billing duration of 24 hours" | Instance list and minimum from [aws.amazon.com/ec2/instance-types/mac](https://aws.amazon.com/ec2/instance-types/mac/) and [Dedicated Hosts pricing](https://aws.amazon.com/ec2/dedicated-hosts/pricing/); AWS publishes the rate only through the pricing calculator, so the hourly figure is from the secondary site instances.vantage.sh |
| AWS EC2 Mac | `mac-m4.metal` (M4, 10 cores, 24 GB) | about $1.23 per hour on demand | 24 hours | same; AWS also lists `mac2-m2`, `mac2-m2pro`, `mac2-m1ultra`, `mac-m4pro`, `mac-m4max`, `mac-m3ultra` |
| MacStadium | Mac mini M2.S (M2, 8 GB, 256 GB) | $109 per month | monthly, prepaid on the first of the month | [macstadium.com/pricing](https://www.macstadium.com/pricing) |
| MacStadium | Mac mini M4.S (M4, 16 GB, 256 GB) | $149 per month | monthly | same |

Per-measurement cost estimates: Scaleway M4-S about €5.30 for one 24-hour window; AWS `mac2.metal` about $15.60; AWS `mac-m4.metal` about $29.50; MacStadium $109 to $149 for a month regardless of use. An Apple Silicon Mac already owned by a maintainer costs nothing and matches how the Intel row was produced.

### 7. Self-hosted GitHub runner considerations

- The runner application supports macOS ARM64 ("currently in public preview") and macOS 11.0 or later ([self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners), read 2026-11-09).
- GitHub security hardening: "self-hosted runners should almost never be used for public repositories on GitHub, because any user can open pull requests against the repository and compromise the environment" ([Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions), read 2026-11-09). Fleur is public (`gh repo view`: `PUBLIC`).
- A measurement on a rented host therefore should not depend on registering it as a repository runner. Running the packed doctor over SSH, or by hand, and retaining its `--json` evidence artifact the way `docs/setup.md` records the Intel row, avoids exposing a runner to fork pull requests. If a runner is ever wanted, GitHub's ephemeral `--ephemeral` / just-in-time registration on a disposable host is the documented safer form.

### 8. How Fleur measures today (for comparison)

- `.github/workflows/compatibility.yml` runs the Docker-based isolation and readiness jobs only on `ubuntu-24.04` and `ubuntu-24.04-arm`; the `native-platforms` matrix uses `macos-15-intel` and `macos-15` for Bun, browser and tooling fixtures without Docker.
- `.github/workflows/native-setup.yml` `existing-docker` runs the packed doctor and owned smoke on `ubuntu-24.04` and `ubuntu-24.04-arm` only.
- The `darwin-x64-desktop` floor row (Docker Desktop 4.96.1, Engine 29.9.2, Linuxkit 7.0.14-linuxkit) was measured on the Intel development machine, not on a hosted runner (`docs/setup.md`, "Intel macOS was measured with ...").
- Apple Silicon is a deferred target under the approved platform amendment and does not block #24 (`docs/setup.md`, `docs/ci.md`).

## Recommendation

1. Do not plan any `darwin-arm64` Docker measurement on GitHub-hosted macOS runners, including `-xlarge`, and do not expect a future hosted chip upgrade to change this: Apple exposes nested virtualization only to Linux guests, GitHub runners are macOS guests, and GitHub confirmed on 2026-01-08 that the feature remains unavailable. Keep `macos-15`/`macos-26` for the free, Docker-less native fixtures only.
2. When an Apple Silicon row is wanted, produce it the way the Intel row was produced: run the packed doctor on bare-metal Apple Silicon and record the JSON evidence. Cheapest credible options in order: a maintainer-owned Apple Silicon Mac (free); a Scaleway Mac mini M4-S for one 24-hour lease (about €5.30, reconfirm the rate on the pricing page before ordering); AWS `mac2.metal` or `mac-m4.metal` for 24 hours (about $16 to $30); MacStadium only if a month-long host is useful for repeats ($109 to $149).
3. Do not register a persistent self-hosted runner for the public repository. Drive the rented host over SSH with a Fleur-owned script, or by hand, and keep credentials and machine-local paths out of the recorded evidence, consistent with AGENTS.md.
4. Because the Apple Silicon target is deferred, treat this as a decision input for the map rather than a blocker; a one-day rental per measured Docker Desktop baseline is cheap enough to schedule when the target is admitted.

## Open questions

- Scaleway's exact current hourly rate and whether a fresh account can order Apple silicon immediately (the pricing page could not be fetched by automation; the €0.22/hour M4-S figure came from search snippets of that page).
- AWS Dedicated Host rates were taken from a secondary aggregator because AWS publishes Mac host prices only through its calculator; confirm in the console before any purchase.
- Whether Docker Desktop on a rented Mac mini M4 running macOS 26 reports the same kernel flavour (`-linuxkit`), cgroup driver and security options as the Intel row, which determines whether the catalog needs a distinct `darwin-arm64-desktop` identity tuple or only new version values.
- Whether any maintainer already owns an Apple Silicon Mac that could supply the first row at no cost.
- Whether GitHub changes its hosted macOS hypervisor; the runner-images issues (#13505) are the place to watch, and nothing in Apple's current Virtualization framework suggests macOS guests will gain nested virtualization.
