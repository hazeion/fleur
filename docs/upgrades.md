# Exact upgrades and generated guidance

`fleur docs` reads the current pin's offline core reference. `fleur docs catalog`
returns catalog version 1, command option metadata, structured input schemas,
result schema and guidance/upgrade errors with exit categories and recovery
commands. Dispatch, help and the offline operation reference use the same command
definitions. New guidance operations validate the grammar that produces their
input schemas. Existing operation validators additionally enforce their own
semantic bounds and authority requirements.

## Refresh

Run `fleur docs refresh --preview` to see bounded before/after file diffs and a
content-bound token. `fleur docs refresh` updates unchanged generated content.
Edited generated content requires `fleur docs refresh --replace <token>` after
review. Any later edit invalidates that token. Refresh never installs packages or
changes the exact Fleur version or package graph.

Fleur tracks generated-section checksums in `.fleur-guidance.json`. Commit that
file with generated guidance. Text outside the one marked section in AGENTS.md
and CLAUDE.md remains byte-identical. The skill and docs/fleur.md are Fleur-owned
whole files. Both instruction files reference the tailored project-local TDD
skill. Legacy projects without checksums can preview and explicitly adopt the
current generated content. Missing, duplicated or malformed instruction markers,
invalid UTF-8, symlinks, linked files and oversized input refuse replacement;
restore intended markers/encoding manually while preserving user content first.

Doctor reports `GUIDANCE_MISMATCH` for stale/edited/missing guidance or retained
file-update evidence. `fleur verify` refuses before executing tools until it is
resolved. Help, docs and read-only database/lifecycle diagnostics remain available;
they retain their ordinary version, target, bounds and authority checks.

## Upgrade

Invoke the explicitly selected **target release's** CLI with
`fleur upgrade --to <exact-version> --preview`. Only an exact stable target and a
source-owned documented direct path are admitted; no latest, registry-discovered
path, implicit intermediate release or compiler fallback exists. Ordinary
commands still use the project pin. `fleur docs upgrades` lists the running
release's paths and instructions. This first release has no historical paths;
requests without an admitted edge return `UPGRADE_PATH_UNSUPPORTED` before writes.
Synthetic release fixtures prove the engine and target dispatch without inventing
published releases.

An admitted path checks format/contract metadata, selected compiler, manifest pin
and its own source-owned compatibility requirements before writes and again
before success. Its bounded preview includes every protected file change,
including package/pin changes. A pre-1.0 breaking upgrade requires a new minor,
explicit instructions and `--accept <token>` from its preview. Stable-major
contracts and pre-1.0 patch contracts cannot declare breaking edges. Existing
exact Fleur dependency pins can change only with the path's reviewed frozen-lock
diff. Package installation remains a separate explicit action; an admitted path
must document and check its exact dependency/runtime requirements. No package
manager runs as a hidden upgrade effect.

Release paths may change only the reviewed guidance, metadata and tooling graphs.
They cannot change application source, migration or seed content. Application
changes described by breaking instructions are the user's separate reviewed work.
No upgrade performs database migrations, resets or restores. A pin rollback never
reverses schema changes, and a downgrade has no implicit authorization.

## Failed or interrupted file updates

Before changing protected files Fleur durably records originals in a private,
mode-0600 journal under the ignored `.fleur/update` directory. Updates serialize
through that directory. A handled failure restores unchanged owned files and the
previous pin. Concurrent edits, replaced directories, unsafe paths or incomplete
writes preserve evidence and return `RECOVERY_REQUIRED`, with unrestored relative
paths. Never delete the evidence to force a retry.

After the original owner exits, run `fleur docs refresh --recover` using the exact
CLI release that performed the update. This narrowly scoped recovery can operate
when the pin itself changed or became damaged. It restores verified originals;
it does not replay the upgrade, replace concurrent edits or touch a database.
A live/reused owner PID, wrong recovery release or unverified journal refuses.
Inspect retained paths manually if safe restoration is incomplete. File rollback
has bounded input and filesystem identity checks; uncertain partial writes remain
explicit recovery work.

## Verify

`fleur verify` checks guidance, then Bun tests, Microsoft TypeScript, oxlint, the
independent ESLint engine and a production build, within one command deadline.
An empty test suite fails. It uses the release's fixed tool commands, rather than
arbitrary package scripts. Approved dependency maps must retain exact pins; an
explicit exact matching Fleur installation is admitted as an additional package.
Verification does not install tools or silently change compiler. Run the named
pinned tool directly for detailed failure diagnostics. Production build retains
its prerequisite/isolation checks. Application database tests must still use
Fleur-supported disposable targets; this command supplies no alternate database
provisioner and never uses development data as test data.

The synthetic recovery recipes in `fleur docs core` describe symptoms, diagnostics,
required authority, recovery and resulting-state evidence. They cover interrupted
setup, lifecycle/reload, maintenance/restore and reactive reconnect/unknown writes.
The referenced tests use controlled host fixtures or uniquely owned disposable
PostgreSQL/browser environments. Simulated setup does not establish native setup
qualification. Unknown mutation outcomes are reconciled without automatic replay
or a false claim that a particular submission is known to have committed.
