# Fresh Ubuntu guest verification

`scripts/verify-fresh-linux.ts` verifies an owned full-system Ubuntu 24.04 amd64 guest using the fixed internal candidate or the source-owned ordinary installation profile. The ordinary catalog contains the exact reviewed Ubuntu 24.04 prerequisite tuple. Internal candidate verification does not add release admission. Local tests cover refusal, transport and artifact boundaries; actual guest execution and its evidence are recorded separately below.

The command has two modes:

```sh
bun scripts/verify-fresh-linux.ts --observe

# Run only on an explicitly authorized disposable Linux x64 host or Darwin x64 TCG verification host.
FLEUR_OWNED_DISPOSABLE_HOST=yes bun scripts/verify-fresh-linux.ts \
  --run --image /owned-input/ubuntu-24.04-server-cloudimg-amd64.img \
  --candidate source-owned --bun-archive /owned-input/bun-linux-x64.zip
```

Both commands emit one JSON result. Observation returns exit 4 because tool discovery does not establish executable infrastructure. Execution returns 4 for missing authority, bad artifacts, unavailable infrastructure or incomplete guest proof, and 5 when cleanup cannot be established. A successful verification can return 0 only after the real guest path passes. Such a report still says `runtimeSupport: unverified`; release admission requires independent review and a later source change.

No host package installation, KVM permission changes, Docker commands, global SSH configuration, host bind mounts, Docker sockets or credentials are used. QEMU, qemu-img, SSH, SCP, ssh-keygen, unzip, Python and Git must already be available. Linux uses cloud-localds; Darwin x64 uses the existing hdiutil command and admits only TCG. This script does not install them. `FLEUR_GUEST_ACCELERATOR` selects exactly `tcg` or `kvm`, defaulting to TCG. It never silently falls back after KVM fails. Darwin rejects KVM and HVF. The report preserves actual host OS and guest OS separately. Successful full-system TCG execution is guest functional evidence, not native CPU performance evidence.

## Artifact and transport identities

The Ubuntu image is the exact official noble release dated 20261017. Its authenticated SHA256 is `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94`, with 621284352 bytes. Prior artifact research authenticated Canonical's signed checksum manifest against primary fingerprint `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81`; it did not boot the image. The command rechecks the frozen payload hash, copies through a retained handle into private storage, rejects unexpected image metadata, and runs qemu-img validation before boot.

The Bun 1.4.3 Linux x64 ZIP uses the already pinned compatibility bootstrap hash `3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18`. Only `bun-linux-x64/bun` is extracted inside the disposable guest. `prepare-fresh-linux-guest.py` uses Python standard-library ZIP handling, so the guest needs no unzip installation. It rechecks the fixed archive SHA, size, exact entry names/types/count and executable bound, writes exclusively through an owned directory descriptor, and authenticates the final retained output bytes before reporting their digest. Cleanup atomically claims its output into a fresh private quarantine before deleting an identity-matched owned file. A foreign entry captured during that claim is retained with cleanup-unconfirmed status; an already-observed foreign public entry stays in place. These checks describe the observed verification boundary; arbitrary same-user changes after verification remain outside it. The verifier checks its structured output identity before continuing. It accepts no artifact-pin override. Tests acquire the exact official ZIP in an owned fixture, never execute its Bun binary, and exercise missing unzip, unsafe inputs, existing output and partial-write cleanup. Host capability observation and its existing assertions remain unchanged. No global Bun installation changes.

The verifier builds the internal native candidate from the current source with `build-native-candidate.ts`. It refuses caller-supplied candidate archives or runtime profile overrides. It records the builder's archive and source-file identities. The existing runtime probe comes from a separately recorded exact Git commit and archive hash. Uncommitted experiment edits do not enter that archive.

`observe-fresh-linux-boot.ts` performs one nonblocking observation through the same pinned loopback SSH transport. It first checks cloud-init's boot-finished marker without invoking cloud-init during busy startup. The marker alone cannot establish readiness: the command then requires a completed, non-degraded JSON status with no reported errors, and the exact guest nonce. Pending initialization and initial connection refusal remain retryable. The exact two-line pre-authentication connection-reset response (LF or CRLF) from the expected loopback port also remains pending, only with SSH exit 255 and empty stdout; mixed identity/authentication diagnostics, unexpected output and other endpoints remain fatal. Otherwise, host-key failures, malformed status, mismatched identity and other SSH failures remain errors. The parent retains its three-minute boot deadline, caps each SSH attempt at ten seconds or the remaining boot budget, and keeps the three-second connection limit. Synchronous relay setup consumes that same attempt budget. If setup returns after its deadline, the host requests cancellation immediately before yielding to relay readiness; otherwise its watchdog receives only the remaining time. This does not preempt a blocked OS call or extend the separate local cleanup deadline. Tests execute the remote shell operation through disposable external SSH/cloud-init protocol fixtures, including pending-to-ready transitions and rejection cases.

Readiness deadline-boundary tests inject a monotonic clock only into the readiness loop to simulate elapsed scheduling time after completed observations. Their original total and per-attempt deadlines remain unchanged; actual SSH watchdogs, process retirement and cleanup use the real clock. The default verification path uses the real monotonic clock and still admits an initial observation bounded by the available partial budget. These controlled-clock tests do not establish native runtime or performance support.

`archive-fresh-linux-probe.ts` packages the existing restriction-probe tree and its two sibling rendering inputs, `package.json` and `bun.lock`, from one exact Git commit. It validates actual tar member bytes through a retained archive descriptor against the tracked Git blob identities. The streamed, validated and final retained-byte hashes must agree before success. Failure cleanup first claims the public output into a fresh private namespace, then deletes only the original owned inode. Foreign replacements are retained with explicit cleanup uncertainty. The private namespace assumes this helper is its writer, rather than containing unrestricted same-user interference. Dirty or untracked replacements never enter the archive. Export attributes that omit or alter required tracked bytes cause a failure. Its tests construct real temporary Git repositories and execute a controlled extracted probe that reads those sibling inputs. They do not run Docker or the actual runtime restriction experiment.

The private NoCloud seed creates a nonce-marked test account with passwordless guest sudo, ephemeral SSH transport keys and a pre-generated guest host key. This is fixture preparation, not evidence of a user's consent. It installs no Docker packages or dependency closure. SSH is bound to loopback, uses a fixed known-host key, ignores personal SSH configuration and agents, and requires public-key authentication. The only mutable disk is an owned qcow2 overlay. No host data directories are shared.

The guest records ordinary-user APT list evidence after the actual setup attempt. It hashes readable regular index files through retained no-follow descriptors, with a 64 MiB per-file limit, a 512 MiB total limit and at most 1,024 directory entries. File identity, byte count and directory identity must remain stable. The literal regular `lock` file and literal `partial` and `auxfiles` directories are reported as metadata with type, owner and mode; their contents are never opened. APT itself creates these acquisition directories and its lock, as described in [APT's acquisition source](https://sources.debian.org/src/apt/3.0.3/apt-pkg/acquire.cc/). Unexpected types, links, unreadable index files and changing inputs fail verification. This capture neither validates repository signatures by itself nor changes permissions to read privileged files. An incomplete setup remains incomplete, with its original transcript and dependency simulation retained.

## Owned NoCloud media on Darwin

`prepare-nocloud-seed.py` is an internal verification command invoked by the Darwin branch. It reads exactly two regular owned files through retained directory/file descriptors, bounded to 64 KiB user-data and 16 KiB meta-data. It retains the original input descriptors and directory identity through construction, then rechecks their bytes, entries and original path before publication. It stages those bytes in a new private directory and runs hdiutil makehybrid with ISO9660/Joliet labels cidata, without attach, mount or overwrite options. The tool inherits the retained staging directory as cwd. Its output/deadline and owned process group are bounded; a surviving tool group remains a failure.

The command inspects the actual image through a retained descriptor, at most 8 MiB. It validates CD001 descriptor/version fields, matching numeric encodings and volume bounds, the primary CIDATA/cidata and Joliet labels, the root directory, exact required filenames and nonoverlapping in-volume extents, and both recorded file bodies. Final output bytes and inode/path identities are checked after exclusive hard-link publication. Cleanup atomically claims the staging directory, its input directory and each known file into a fresh private nonce namespace before deleting identity-matched owned entries. Foreign replacements are retained there with cleanup-unconfirmed status. This private namespace assumes the helper is its writer; it does not contain unrestricted same-user interference. Unknown partial artifacts remain in private staging with cleanup-unconfirmed status; existing output is preserved. The harness compares the reported input hashes to the exact generated cloud-init content before QEMU can use the seed.

Tests on macOS construct and inspect a real hdiutil ISO. Other test hosts use an explicitly identified owned ISO command-protocol fixture for portable artifact validation; that is not evidence hdiutil ran there. Neither path mounts media or boots a guest. These media checks establish construction and content identity only. Actual cloud-init consumption and pinned SSH readiness remain later execution proof.

Primary format references: [Canonical NoCloud source documentation](https://github.com/canonical/cloud-init/blob/main/doc/rtd/reference/datasources/nocloud.rst), [ECMA-119](https://ecma-international.org/publications-and-standards/standards/ecma-119/), [Microsoft disc formats](https://learn.microsoft.com/en-us/windows/win32/imapi/disc-formats), and the installed hdiutil makehybrid help.

## Guest proof and honest failures

The guest requires its nonce marker, Ubuntu 24.04 x86_64, its own systemd, QEMU virtualization identity and exact Bun. It captures package inventory, source/key hashes, groups and service state; existing Docker packages invalidate a fresh fixture.

The actual packed CLI runs doctor, noninteractive setup, a denied PTY confirmation and explicitly scoped `once` PTY fixture responses. Denied and noninteractive paths must preserve the baseline. Automated PTY responses are labeled test inputs and never legal acceptance or proof of real human consent. No production flag, environment variable or API mints grants.

After setup, the report captures actual dependency simulation and signed-index byte identities. Missing distro dependencies remain a failure. They are not preinstalled to make the fixture pass. When exact installed packages and active services leave the ordinary user without Docker access, the guest inspects the product adapter's separate root-equivalent enrollment plan. Package-side-effect permission cannot cover that account enrollment: action, method, target, checksum, UID, group and endpoint must match a new explicit PTY fixture prompt. After enrollment it requires two unchanged stale-session setup probes with exit 3 and `new-login-required`, while only the account gains the Docker group. Root readiness, pre-enrollment and in-process group-refresh substitutes cannot satisfy this handoff.

The guest then emits `ok: false`, phase `new-login-required` and exit 3. A private exclusively created checkpoint retains the original pristine baseline, complete initial phase evidence, nonce, boot ID, ordinary account/group identities, candidate/source/archive byte identities and the original guest deadline. Candidate inventory checks time and counts every file and directory during incremental enumeration, at most 5,000 entries, before inspecting or queuing the entry. It retains the 8 MiB source-file and 32 MiB source-total ceilings and sorts only admitted bounded records. Retained descriptors and final byte/path/root checks precede publication; malformed inputs, preexisting state, changed bytes, symlinks and replaced lab directories fail closed. Partial or uncertain state is retained and blocks a new initial workflow. This state assumes the owned verification lab has one trusted writer; it does not contain unrestricted same-user interference. Automated replies remain fixture authority, not real human consent.

The host retains that first report and its checkpoint digest, completely reaps the old SSH workflow, and opens at most one fresh ordinary-user connection using the same pinned key and client identity. Both workflows explicitly set `ControlMaster=no` and `ControlPath=none`. Each connection must emit its exact nonce-bound session-start frame within 10 seconds, retaining the 3-second connection ceiling; that frame establishes transport start only and cannot replace guest proof. Missing, malformed, duplicate or wrong-nonce framing fails closed. The internal session command is imported directly by the verifier; cancellation aborts and awaits its owned process-group cleanup before VM disposal. Termination sends the owned group TERM first, then escalates to KILL after 100 ms if needed. Grace, close and confirmed group disappearance share the original 3-second cleanup bound from the first termination request; expired workflow/start budgets cannot resume. Its scoped protocol result does not authenticate images or admit native support: the parent retains the frozen artifact and final-proof gates.

Resume accepts only the anchored checkpoint, original boot/nonce/UID and matching candidate/source/archive bytes. It retains the original baseline and guest deadline, requires the new numeric session groups to equal the recorded post-enrollment account groups, checks unchanged socket and installed state, and claims the checkpoint once through an exclusive private marker. Stale login, replay, changed bytes, path or identity, expired budget and uncertain state stay incomplete; resume never repeats installation or enrollment. The original and fresh-login snapshots remain separately recorded: human `id` text gains Docker membership, while exact numeric memberships and every package/service/source field are checked independently. Both SSH workflows share one original host 900-second budget, while guest subprocesses retain their existing individual ceilings and the original guest aggregate deadline.

A valid new login alone does not establish readiness. For example, an unavailable daemon after resume returns host and guest exit 4, installation evidence pending, runtime support unverified and `humanConsentProof: false`. A successful native guest execution has not been demonstrated by protocol fixtures. An incomplete host-report excerpt is:

```json
{
  "ok": false,
  "runtimeSupport": "unverified",
  "installationEvidence": "pending",
  "sessions": {
    "initialGuest": { "ok": false, "phase": "new-login-required" },
    "guest": { "ok": false, "error": { "code": "NATIVE_SETUP_INCOMPLETE" } }
  }
}
```

If ordinary-user readiness becomes available through supported setup, the verifier inspects the separate digest-image acquisition plan and answers exactly one matching image/endpoint/checksum prompt. Package installation or account-access prompts at that boundary are rejected without a reply. It then runs doctor twice, preserves an unrelated stopped container and global context, and verifies owned cleanup. Each repeat requires CLI, daemon, Compose and smoke to be ready, smoke cleanup to succeed, and the exact pending-release doctor envelope with exit 4. A failed smoke with successful cleanup cannot pass. It then executes the existing runtime probe with healthy-containerd and idle-stress options. No GC, retained-value, idle, resource, isolation or deadline assertion is removed. Missing compiler prerequisites or a failed probe remain explicit incomplete evidence.

The host requests QMP powerdown, then terminates and reaps only its owned QEMU child if needed. Owned temporary disks, seed and keys are removed after termination. The JSON report carries guest diagnostics and bounded serial output. There is no CI job or automatic infrastructure provisioning in this change.

On 2026-10-20, an actual Ubuntu 24.04 amd64 TCG guest ran an internal candidate whose product-source and CLI provenance matched commit `982263f4072ad5d6e9e2617d46a4929d2d100319`. It installed all five frozen Docker packages, completed separate user enrollment, returned `new-login-required` on two unchanged stale-session probes, and resumed through a fresh ordinary-user SSH login. Separate digest-image authority then enabled smoke readiness. Both final doctor runs reported CLI, daemon, Compose and smoke ready with smoke cleanup true, while retaining exit 4 and release unverified. The verifier confirmed preservation of the unrelated stopped container and global context, then owned VM reaping and credential removal.

This execution used a private harness variant containing a failure-only read-only access survey. Product source was unchanged, and the survey was not invoked: `accessSurvey` is absent from the report. PTY replies remained automated fixture inputs, not human-consent evidence; TCG supplied no native CPU performance proof.

The restriction probe then exited 1 with `gcc prerequisite missing; nothing installed`. Its worker container and image were never created, so the later restriction, resource, GC/idle and runtime-profile gates were not exercised. The combined report correctly remained `ok: false`, `installationEvidence: pending` and `runtimeSupport: unverified`, with `RESTRICTION_EVIDENCE_REQUIRED`.

Remaining release work includes the restriction-probe prerequisites and subsequent runtime isolation, resource, GC/idle and cleanup evidence; failure, interruption, revocation and recovery cases on separate fresh overlays; and the other Linux/macOS tuples. The existing runtime probe is a scoped experiment and cannot set the aggregate v1 compatibility gate true.

References: [QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html), [NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html), [Ubuntu cloud image](https://cloud-images.ubuntu.com/releases/noble/release-20261017/), [Canonical checksum verification](https://ubuntu.com/docs/public-images/public-images-how-to/verify-image-checksum/).

The internal candidate observes its existing privileged local-archive APT simulation through a pass-through host-command adapter. It emits one labelled JSON record to stderr with the actual status, exit and at most 4,096 UTF-8 bytes from each result stream, with explicit truncation flags. The owned guest PTY retains this diagnostic privately. The adapter delegates once with the original arguments, timeout and context; it does not retry, authorize or change the command result. Other commands are not traced. The ordinary release excludes this adapter. These command-protocol tests establish observation behavior, not a successful native installation or the cause of an uncaptured earlier failure.

Diagnostic delivery is best effort: an unavailable, full or partially written sink supplies no complete diagnostic evidence. Delivery uses one asynchronous descriptor write with its own error callback, without awaiting, retrying, changing descriptor flags or adding stream-wide error listeners. The original command outcome still governs setup. Owned pipe checks cover closed and full sinks on the tested host; they do not establish every platform's stream behavior.

The internal candidate explicitly composes separate plan and install observation phases. The adapter's default remains plan-only. Its install phase records only the existing noninteractive local-archive installation command with no-download, no-remove and no-upgrade; it adds no command, authority or retry. The phases share bounded best-effort delivery and preserve the original command result. Produced-artifact protocol tests cover composition, one actual external invocation and real PTY/closed/full-pipe behavior on the test host. An absent or incomplete record remains missing diagnostic evidence. Actual installation success and release support require the real guest proof.

The guest verifier preserves version 1 command results whose `data` is null.
Unavailable setup or recovery results do not authorize enrollment: the report
stays incomplete with its original setup and doctor evidence, without an
additional enrollment prompt or login checkpoint. Missing authority-plan fields
and non-object data at handoff/readiness boundaries are rejected explicitly;
null data cannot count as a plan, new-login requirement or readiness proof.

## Artifact preparation diagnostics

The initial guest artifact preparation keeps its existing ten-second host work
budget, including transport startup and observation overhead. SSH still uses a
three-second connection limit. It neither starts the compiler prerequisite nor
changes boot, setup, session, resume or restriction budgets.

The host preserves `preparationObservation` even when preparation fails. It
records the local deadline flag, transport exit or signal, bounded byte counts,
and allowlisted phase events with host elapsed times. The opt-in Bun events
identify archive authentication, entry validation, executable extraction,
retained-output authentication, archive reauthentication and output custody.
Candidate and restriction archive commands have separate start/completion events.
Successful Bun evidence requires each start/completion pair in the producer order inside the Bun phase, followed by one validated Bun result. Missing, duplicate, crossed, out-of-scope and post-completion events are rejected. Guest elapsed values are nondecreasing relative integer milliseconds within the applicable work budget; no guest epoch is compared to a host timestamp. A failed run retains only its valid observed prefix, including a valid extraction-cleanup prefix. A valid Bun result is retained even if a later archive command fails. Raw stdout,
raw stderr, arbitrary JSON fields and transport diagnostic text are omitted.
An exit 137 alone remains a transport-or-remote-command failure; it does not prove
that the host timer fired or that any particular guest stage completed.

The shared host-only Python helper retains the actual SSH leader unreaped after exit. A private descriptor carries its PID, exit tuple and bounded process inventory; TypeScript completes owned group signals before explicit release and reaping. The fixed /bin/ps inventory reads only PID, process-group and state columns, never command arguments. Its absolute executable availability is included in host capabilities, and both helper source hashes are included in verifier provenance. Local transport retirement has a separate bounded
three-second cleanup period and reports uncertainty if retirement is unconfirmed.
Darwin selects the complete retained process group, including its zombie leader
and descendants without terminals; Linux retains the global query. Exit,
cleanup inspection and final release each require a fresh inventory. The
one-second query work deadline includes tool startup and selector setup; late
OS returns are refused without a new allowance. Query retirement still has its
original separate bound, protects partial setup failures, and requires a fresh
WNOWAIT ownership observation before signaling or reaping the probe. Successful
retirement also requires complete error-free control EOF and actual helper exit
zero without a signal, within the original cleanup deadline. Physical group
absence cannot replace the third release check or conceal a late helper error.

If cancellation arrives before the relay sends an SSH start request, the
observation remains failed with a null SSH exit. Local cleanup is confirmed only
after that idle relay reaches complete control EOF and actually exits zero
without a signal, within the same original cleanup deadline. Unexpected idle
control output, a nonzero helper exit or late retirement keeps cleanup unconfirmed.
Portable OS-command fixtures cover these failure contracts; controlled same-UID native
comparison evidence does not qualify every UID, platform or runtime profile.

The report separates work elapsed time from local cleanup elapsed time. A detected live local survivor invalidates preparation even after confirmed retirement; that refusal is distinct from an expired work timer. This does not establish cleanup of remote guest work. The owned VM teardown
remains necessary. Success requires authenticated Bun output and completed
candidate/restriction extraction in the expected order. These diagnostics do not
establish that preparation fits within ten seconds on every guest, and they do
not change runtime or release admission.

Protocol rejection latches failure and stops further decoding. It does not
unnecessarily signal an already exiting SSH leader: remaining bytes are counted
and discarded only within the original remaining work budget. A stalled failed
protocol is terminated by that same watchdog, without starting a new budget.
The total two MiB limit includes discarded bytes and triggers immediate
termination. Signal failures also enter finite cleanup immediately. Primary
protocol evidence and any secondary cleanup uncertainty are both retained;
neither a denied signal nor a cleanup failure becomes successful preparation.

Bun cleanup telemetry is best effort only within the failure cleanup path. If an
ordinary phase event cannot be delivered, preparation still fails, but another
failed cleanup-event write cannot bypass the original owned-file claim/deletion
or foreign-replacement preservation. A lost final result remains incomplete
host evidence. No archive, retained-output or custody check is suppressed.


## Recorded restriction-helper input (internal)

The owned verifier can select `--recorded-helper-artifacts <fixed-pair-directory>`
instead of `--compiler-debs`. This internal input supplies only `filter.so` and
`abuse` bytes; it cannot choose a manifest, compiler, runtime profile or admission
policy. The default route still executes the pinned local GCC with the original
sources and flags. Recorded mode requires the complete original owned NoCloud
binding and the full disposable VM route, including the same initial/resumed
login binding. It is unavailable to ordinary persistent hosts and workers.

The source-owned [origin record](../experiments/compatibility/runtime-probe/recorded-helper-origin.json)
binds the 47,576-byte pair to producer report SHA256
`de686cf6344410c3d29e1dcab19bcdabaddc05e4a7d4bdf50320f9c649282bbf`,
GCC 13.3.0, its authenticated 38-package closure, original C sources/flags, ELF ABI
and pinned Bun image. Both fixed inputs, current C sources and retained file
identities are authenticated again before Docker build. Reports distinguish
`prebuilt-origin` from local compilation: `compiler_pin_verified` is false, no
local `gcc` observation is supplied, and producer compiler execution is a
separate historical fact. This adds no OS, control, readiness or release row.

The recorded build context remains inside the owned guest until that entire VM
filesystem is disposed. Its local receipt explicitly remains pending; no local
recursive cleanup or success is claimed. Existing worker/image/daemon/waiter
cleanup assertions remain required. Host acceptance additionally requires the
owned VM to be reaped and actual scratch/overlay removal, reported as
`artifactDisposal.complete`. Uncertain host artifact custody instead retains the
scratch and fails verification. All original preparation, runtime, GC/idle,
resource, isolation and deadline gates remain unchanged.

Portable text-artifact, filesystem and report-protocol tests cover this route;
they do not establish execution of the genuine compiled pair. Separately, the
genuine pair passed two native recorded-mode runs on the existing Ubuntu 24.04
x64 tuple, with independent runtime, custody and disposal evidence review. See
the [recorded-helper evidence](setup-artifact-evidence.md#recorded-helper-verification-on-the-existing-ubuntu-tuple).
No new platform qualification or aggregate v1 compatibility claim follows from
this input path.

## Ubuntu 26 internal candidate

`build-native-candidate.ts --out <new-owned-directory> --fixture ubuntu26-amd64`
selects one fixed, authenticated Resolute catalog. The default remains
`ubuntu24-amd64`; arbitrary catalog paths, hashes and profiles are refused. The
internal archive carries the exact source catalog bytes under a fixed filename.
The ordinary packed package and its Ubuntu 24 qualification records remain
unchanged. Ubuntu 26 has no ordinary admission or Doctor 0 shortcut.

The root NoCloud producer accepts only the source-owned Ubuntu 24 or 26 amd64
target. Its default target is Ubuntu 24. Before creating the manifest, it checks
the actual OS, architecture, init and virtualization. The protected manifest
binds the original OS ID, release and full release-file hash; retained custody
also binds the file and protected ancestry identities. Reopening the original
nonce, boot ID, ordinary UID and manifest SHA cannot authorize a changed OS.
These four public binding fields and the strict root-control reply stay intact.
The ordinary custody observation separately includes validated OS metadata.
The guest reuses that protected observation for the target check instead of
reading OS bytes again through another pathname. Its report identifies this
evidence source; it does not claim a second raw OS observation. Legacy
nonce-only Ubuntu 24 observations use a bounded regular-file snapshot that
allows the standard OS-release alias and consumes the existing phase budget.

Before setup authority or resumed account work, the guest authenticates catalog
bytes against an independent source pin, compares the marker, artifacts and
authentication record, and checks the original OS/architecture target. A marker
cannot authorize its own replacement checksum. Missing or malformed OS metadata
on a full binding is refused. The legacy nonce-only Ubuntu 24 fixture cannot
select Ubuntu 26 or establish its full custody proof. The new catalog stat identities stay inside Python. Its new report fields
contain only hashes and fixed strings.

The historical Resolute catalog retains its pending installation and unverified
runtime labels separately from artifact authentication. Its scoped five-package
maintainer-script digest differs from the historical six-profile digest, and
both scopes are explicit. Portable artifact and command-protocol tests do not
prove native installation or runtime behavior. Two full native Ubuntu 26 runs
and their independent evidence reviews are complete; the proposed source entries
record their exact installation and runtime tuple. Ordinary packed verification
of those entries remains pending.
All existing setup grants, GC/idle, resource, isolation, physical deadline and
owned disposal assertions remain required.

### Exact Ubuntu 26.04 x64 verification

The runner accepts a final `--fixture ubuntu26-amd64` option. It binds the fixed
859,090,944-byte Ubuntu 26 image (SHA256
`5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5`),
the frozen Resolute catalog and the original protected Ubuntu 26 OS record.
The default remains `ubuntu24-amd64`; arbitrary targets and profile paths are
refused. Selecting a fixture grants no installation permission or admission.

On an owned eligible Linux x64 verification host with existing tools, use the
same command as Ubuntu 24 and append `--fixture ubuntu26-amd64`. Supply the exact
Bun archive, image and `--recorded-helper-artifacts` pair. The Ubuntu 24 compiler
DEB closure is refused for this target. `--candidate ordinary-source-owned`
exercises the packed release and requires verified ordinary Doctor/setup results;
`--candidate source-owned` retains the internal candidate's unverified labels.
Both paths retain original host custody, installer/enrollment/image permission,
fresh-login, repeated smoke, runtime restriction, resource, physical-deadline and
disposal checks. Observation alone is not a successful execution.

The host compares the root-attested OS with the fixed image fixture before guest
work. It carries a separate copied OS record alongside the unchanged four-field
custody binding and checks both against the initial and resumed guest reports.
Ordinary terminal profile/evidence selection uses only that original OS record.
Legacy sessions without an original OS record remain Ubuntu 24-only; an explicit
Ubuntu 26 report cannot adopt that fallback.
