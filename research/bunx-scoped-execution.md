# bunx resolution, caching and Bun-shebang execution for a scoped package

Date: 2026-11-09. Resolves Wayfinder research ticket #173 (map #160). Bun sources are cited at
`oven-sh/bun` commit `2596ac5d391d47804c93a42bdbe615804aa62387` (main, 2026-11-07, `package.json`
version 1.4.4). Local checks ran with Bun 1.4.4 (`38afee6c8`) on macOS x64 against a scratch
`BUN_INSTALL_CACHE_DIR`; nothing was published to any registry.

## Question

How does `bunx @hazeion/fleur` resolve, cache and execute a package whose `bin` is a
`#!/usr/bin/env bun` TypeScript file with `engines.bun` set to `>=X.Y.Z`? Which version does
`bunx` pick when none is given, how long does it cache, does `@0.1.0` pin reliably, does the
executable run through Bun with no hidden Node, does Bun honour `engines.bun` or
`packageManager`, what happens when a project already has the package installed, and what do
first-run download size and time look like?

## Summary answer

- `bunx @hazeion/fleur` with no version runs `bun add @hazeion/fleur` into a private per-user
  tree named `@hazeion/fleur@latest` under `<install cache>/.bunx-<uid>/`. Bun resolves the
  registry's `latest` dist-tag (falling back to the highest release only when `latest` is
  deprecated). The tree is reused for one day; after that `bunx` deletes the tree's lockfile and
  re-runs `bun add` with `--no-cache`, so a new `latest` is picked up. Trees are never evicted by
  `bunx` itself; `bun pm cache rm` clears the whole cache directory.
- `bunx @hazeion/fleur@0.1.0` pins the package version reliably: the tree is named
  `@hazeion/fleur@0.1.0`, its `package.json` records the exact version, and the daily refresh
  re-runs `bun add @hazeion/fleur@0.1.0`, which cannot move the package. Only *transitive*
  dependencies may be re-resolved within the ranges Fleur's own dependencies declare, because the
  refresh removes the tree's `bun.lock`. `@latest` typed explicitly asks the registry on every run.
- The executable runs under Bun with no Node involved: `bunx` spawns the `node_modules/.bin`
  symlink directly, so the kernel honours `#!/usr/bin/env bun`. Node is only consulted for a
  `#!/usr/bin/env node` shebang (or forced to Bun with `--bun`). A probe confirmed
  `process.execPath` is the Bun binary and `Bun.version` is set, on a machine that has Node.
- Bun ignores `engines` entirely ("Nothing: `engines` is not checked"; `--ignore-engines` is
  accepted as a no-op) and has no handling of `packageManager` at all; both are open feature
  requests. A probe package with `engines.bun: ">=99.0.0"` and `packageManager: "bun@99.0.0"`
  installed and ran without any warning. Fleur's `>=1.4.3` floor must be enforced by Fleur's own
  startup check, not by Bun.
- When the project already has the package in `node_modules`, `bunx @hazeion/fleur` (no version)
  reads `node_modules/@hazeion/fleur/package.json`, finds the `fleur` bin and runs the local copy
  without touching the registry. Any version or tag (`@0.1.0`, `@latest`) skips the local copy.
  A locally installed bin that is missing or not executable is reported, not re-downloaded.
- First run: the packed `fleur-0.1.0.tgz` is 0.54 MB (1.93 MB unpacked, 238 files); the full
  install resolved 102 packages, 34 MB of `node_modules` and 46 MB of cache on macOS x64,
  dominated by the platform-specific `@rolldown/binding-*` (17 MB) and `@tailwindcss/oxide-*`
  (2.6 MB) binaries. A cold `bun add` of the tarball took 1.2 s on a fast connection; warm `bunx`
  runs took about 0.3 s, including Fleur's own startup.

## Findings

### 1. Where bunx installs and how the tree is named

`bunx` keeps each request in its own tree. The root is `.bunx-<uid>` (mode 0700, owned by the
user) under the install cache; the shared temp directory is only a fallback and prints a warning
(`cache_dir`, bunx_command.rs lines 707-757). The tree name is `<name>@<version-or-tag>`, with
`latest` substituted when no version was typed, plus suffixes for options that change the tree's
contents (`+trust`, `+ignore-scripts`, `+min-age=`, `+registry=`) (lines 995-1044). Windows uses
`%TEMP%\bunx-<uid>-<name>@<version>` (lines 760-770).

Observed with Bun 1.4.4: `bunx cowsay@1.6.0` created `<cache>/.bunx-<uid>/cowsay@1.6.0/` holding
`package.json` (`{"dependencies": {"cowsay": "1.6.0"}}`), `bun.lock`, `node_modules/` and
`node_modules/.bin/cowsay -> ../cowsay/cli.js`, with a zero-byte `cowsay@1.6.0.lock` beside it.
`bunx cowsay` created `cowsay@latest/` whose `package.json` records `"cowsay": "^1.6.0"`.

The Bun docs describe the same thing at a higher level: "`bunx` stores installed packages in
Bun's global cache for future use" (docs/pm/bunx.mdx), and the global cache lives at
`~/.bun/install/cache`, overridable with `BUN_INSTALL_CACHE_DIR` (docs/pm/global-cache.mdx).

### 2. Which version bunx picks with no version

`bunx` runs `bun add <name>` without `@latest` when the user typed no version, and the comment
explains why: "Without an explicit tag, `bun add` does not pick the `latest` version if it is
deprecated" (lines 1053-1063). The resolver confirms: when nothing was written explicitly and the
`latest` dist-tag points at a deprecated version, Bun falls back to "`latest`, even if it's a
prerelease, unless it's deprecated. Otherwise the highest release" (npm.rs lines 2075-2092). So
for a healthy package, `bunx @hazeion/fleur` runs whatever `latest` points to.

Because the tree's `package.json` is written by `bun add`, it records a caret range
(`^0.1.0` observed), which matters only for the refresh described next.

### 3. How long a tree is reused

"`bunx my-cli` asks the registry for newer versions of the package and of its dependencies once a
day. If the registry cannot be reached or answers with a 5xx, 429 or 408 status, it warns and runs
the version it has. `bunx my-cli@latest` asks on every run." (docs/pm/bunx.mdx).

In source: `SECONDS_CACHE_VALID = 60 * 60 * 24` ("1 day", lines 340-341). `tree_state` compares
the mtime of the tree's `package.json` with now and marks the tree `Stale` past that age or when
the file is the unfinished placeholder `{}` (lines 663-677). A fresh tree runs its bin without any
network access (lines 1199-1236). A stale tree has its `bun.lock`/`bun.lockb` deleted ("The
lockfile would pin what the refresh is meant to update: the version within a range and every
dependency", lines 1314-1319) and `bun add` is rerun with `--no-cache` so the manifest is fetched
from the registry (lines 1352-1355). An explicit dist-tag (`@latest`, `@next`) sets
`look_for_existing_bin = false` and therefore installs on every run (lines 1097-1100).

If the registry cannot be reached, `bun add` exits with `BUNX_REGISTRY_UNREACHABLE` (75,
`EX_TEMPFAIL`) before linking anything (runTasks.rs lines 1925-1965), and `bunx` rewrites the
tree's `package.json` to mark it fresh and warns "registry unreachable, using cached <name>"
(lines 1462-1470), so an offline user does not wait for a failed attempt on every run.

Observed with Bun 1.4.4: after setting the mtime of `cowsay@latest/package.json` two days back,
`bunx cowsay hi` took 0.76 s and rewrote `package.json` and `bun.lock`; the pinned
`bunx cowsay@1.6.0 hi` kept its 0.3 s warm path.

`bunx` never deletes old trees (no removal code in bunx_command.rs; `count_cached_packages` only
reports). `bun pm cache rm` "deletes everything in the cache directory", which includes
`.bunx-<uid>`; `bun pm cache prune` removes cached *packages* older than 30 days by download time
(docs/pm/cli/pm.mdx, "cache" section). Whether `prune` touches bunx trees is not documented; see
open questions.

### 4. Does `bunx @hazeion/fleur@0.1.0` pin reliably?

Yes for the package itself. A typed version makes `is_versioned` true, which skips both the PATH
lookup and the project's local copy ("It is skipped when the user typed a version, a tag, or a
URL, because that says where the package must come from", lines 1152-1156) and installs into the
tree `@hazeion/fleur@0.1.0` with `bun add @hazeion/fleur@0.1.0`. The daily refresh reruns exactly
that command, so the package version cannot drift. The docs agree: "With a version
(`bunx my-cli@2`), it does not use the local package."

Two caveats. First, the refresh deletes the tree's lockfile, so dependencies are re-resolved from
the ranges in Fleur's published `package.json`. Fleur pins its six runtime dependencies to exact
versions, so only their transitive dependencies (for example `@rolldown/binding-*`) can move within
the ranges those packages declare. Second, `0.1.0` is a semver range as far as Bun is concerned;
`bunx my-cli@2` is also "a version" and resolves to the newest `2.x` at each refresh.

### 5. Does the executable run through Bun with no hidden Node?

`bunx` runs the bin by spawning the resolved file path as `argv[0]` with the passthrough arguments
(`run_binary_without_bunx_path`, run_command.rs lines 2197-2250). Nothing interprets the file; the
kernel reads the shebang. The docs state the consequence: "By default, Bun respects shebangs. If an
executable is marked with `#!/usr/bin/env node`, Bun spins up a `node` process to execute the
file. To run the executable with Bun's runtime instead, pass the `--bun` flag" and "To force a
script to always run with Bun, give it a `bun` shebang" (docs/pm/bunx.mdx).

Node enters only through PATH manipulation for node-shebang packages: `path_for_run` prepends a
`bun-node/node` shim that is Bun when `--bun` was passed *or when no `node` is found on PATH*
(`needs_to_force_bun = force_using_bun || !found_node`, run_command.rs lines 2017-2090). For a
`#!/usr/bin/env bun` file this shim is irrelevant; `env` finds `bun` on PATH.

Bun runs `.ts` entry points without configuration ("Bun supports TypeScript and JSX with no
configuration", docs/snippets/cli/run.mdx), so a `.ts` bin needs no build step.

Observed: a scoped probe package `@scratch/probe` whose bin `probe` is a `#!/usr/bin/env bun`
TypeScript file was installed from a local tarball; `./node_modules/.bin/probe`, `bunx probe` and
`bunx @scratch/probe` all printed `{"bun":"1.4.4","execPath":"<bun install>/bin/bun",
"node":"26.3.0","isBun":true}` on a machine that has Node 24 on PATH. `process.versions.node` is
Bun's emulated Node version, not a Node process.

Bin file mode: Fleur tracks `bin/fleur.ts` as mode 100644 in git, but this does not matter.
`bun pm pack` ORs `0o111` into the mode of every file listed in `bin` (pack_command.rs lines
2418-2422, citing npm's pacote for the same rule), and the tarball showed `-rwxr-xr-x
package/bin/fleur.ts`. Bun's bin linker also chmods the target to `0o777 & ~umask` when it links
(bin.rs lines 865-872 and 1033-1040). npm's docs only warn that bin files need a shebang
(docs.npmjs.com `package.json`, "bin").

### 6. Does Bun honour `engines.bun` or `packageManager`?

No to both.

- `engines`: the `bun install` docs list `--ignore-engines` under flags accepted for compatibility
  with the effect "Nothing: `engines` is not checked" (docs/pm/cli/install.mdx line 629). The
  install argument parser marks `--ignore-engines` as `Satisfied`, meaning accepted and ignored
  (CommandLineArguments.rs lines 431, 473). The manifest parser stores `engines` from the registry
  document (npm.rs lines 915-916) but nothing in `src/install` reads it for a decision; a code
  search for `engines` in `src/install` returns only the parser and the flag table. Issue
  oven-sh/bun#5846 "Support an `"engines"` field in `package.json`" (opened 2023-09-21) and #9346
  are still open.
- `packageManager`: no occurrence in Bun's package.json parser (`src/resolver/package_json.rs`),
  install code or docs other than a Railway deployment guide noting that *Railpack* reads
  `engines.bun`/`packageManager`. Issues #47875 "Use the bun version pinned in `packageManager`
  automatically, like pnpm does" (2026-11-03) and #46596 (2026-10-23) are open feature requests.

For npm itself the field is "advisory only" unless `engine-strict` is set
(docs.npmjs.com `package.json`, "engines"), and npm is not in Fleur's path anyway.

Observed: `bun add` of the probe with `"engines": {"bun": ">=99.0.0"}` and
`"packageManager": "bun@99.0.0"` printed only the normal install summary, and `bun install` in
the probe project itself printed no warning either.

Consequence for Fleur: the `>=1.4.3` floor is documentation for humans and for other tools;
Fleur's own startup must compare `Bun.version` with the floor and refuse clearly.

### 7. What happens when the project already has the package installed

Lookup order in `bunx` (bunx_command.rs lines 1109-1236):

1. If one word names both the package and its bin (`bunx fleur`), look for `fleur` in
   `node_modules/.bin` directories and on PATH and run it. For a scoped name the unscoped part is
   "only a guess. The package's own `bin` field decides the name, so `bunx @uidotsh/install` must
   not run /usr/bin/install" (lines 921-941), so this PATH step is skipped for `@hazeion/fleur`.
2. If no version was typed, read the project's `node_modules/@hazeion/fleur/package.json`, pick
   the bin named like the guess if present or else the first bin, and run it (`find_in_project`,
   lines 1152-1194; `get_bin_from_subpath`, lines 355-420). Fleur declares `"bin": {"fleur":
   "./bin/fleur.ts"}`, so the guess `fleur` matches.
3. Otherwise use the `.bunx-<uid>` tree, installing or refreshing it as in section 3.

If the project has the package but the bin file is missing or not executable, `bunx` exits with
code 126 naming the file instead of downloading another copy (lines 1123-1137, 1179-1186; the
docs say the same for macOS and Linux).

Observed: after `bun add` of the Fleur tarball into a scratch project, `bunx fleur --help` ran the
local copy in 0.32 s with a cold scratch cache, that is without contacting the registry.

Note the npm convention: scoped packages install to `node_modules/@scope/name`
(docs.npmjs.com "scope"), and a scoped package is private by default, so the first publish needs
`--access public` ("Scoped packages are not public by default", same page).

### 8. First-run download size and time

Measured on macOS x64 with Bun 1.4.4 and an empty `BUN_INSTALL_CACHE_DIR`:

| Item | Value |
| --- | --- |
| `bun pm pack` of Fleur at `package.json` version 0.1.0 | 238 files, 0.54 MB packed, 1.93 MB unpacked |
| `bun add <tarball>` into an empty project | 102 packages resolved, 1.2 s wall clock |
| Resulting `node_modules` | 34 MB |
| Resulting cache directory | 46 MB |
| Largest entries | `@rolldown/binding-darwin-x64` 17 MB, `zod` 8.1 MB, `@tailwindcss/oxide-darwin-x64` 2.6 MB, `fleur` 2.3 MB |
| Warm `./node_modules/.bin/fleur --help` | 0.39 s |
| Warm `bunx fleur --help` (local copy) | 0.32 s |
| Warm `bunx cowsay@1.6.0` (tree reuse, small package) | 0.31 s |
| Daily refresh of `bunx cowsay` (registry round trip, small package) | 0.76 s |

The network share of the cold install depends on the connection; the 46 MB came down in about one
second here, so expect a few seconds on an ordinary home link and tens of seconds on a slow one.
The native `@rolldown/binding-*` and `@tailwindcss/oxide-*` packages are optional dependencies
selected per platform, so other platforms download a comparable single binary each.

## Open questions

- Whether `bun pm cache prune` removes stale `.bunx-<uid>` trees or only the `name@version` package
  directories is not documented; the docs describe prune in terms of cached packages.
- `bunx` resolves `bun` for the shebang through PATH, so a project-local or older `bun` earlier on
  PATH would run Fleur even when a newer `bunx` launched it. Fleur's startup floor check covers the
  failure, but the user-facing message should name the Bun that actually ran.
- The measurements are from one macOS x64 machine on one day; Linux and arm64 sizes were not
  measured, and the registry round-trip time for the daily refresh will vary.
- Bun's local copy of a scoped package is found by reading `node_modules/@hazeion/fleur`
  directly; the behaviour when the project installs Fleur under a different name via an alias
  (`"fleur": "npm:@hazeion/fleur@0.1.0"`) was not checked.

## Sources

- Bun docs, bunx: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/docs/pm/bunx.mdx (rendered at https://bun.com/docs/cli/bunx)
- Bun docs, bunx flags snippet: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/docs/snippets/cli/bunx.mdx
- Bun docs, global cache: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/docs/pm/global-cache.mdx
- Bun docs, bun install (compatibility flags table, `--ignore-engines`): https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/docs/pm/cli/install.mdx
- Bun docs, bun pm (cache rm and prune): https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/docs/pm/cli/pm.mdx
- Bun docs, bun run snippet (TypeScript, shebangs, `--bun`): https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/docs/snippets/cli/run.mdx
- Bun source, bunx command: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/runtime/cli/bunx_command.rs
- Bun source, run command (bin execution, node shim): https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/runtime/cli/run_command.rs
- Bun source, npm manifest and version resolution: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/install/npm.rs
- Bun source, install CLI flags: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/install/PackageManager/CommandLineArguments.rs
- Bun source, registry-unreachable exit code: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/install/PackageManager/runTasks.rs
- Bun source, bin linker chmod: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/install/bin.rs
- Bun source, pack bin mode: https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/src/runtime/cli/pack_command.rs
- Bun source, bunx tests (scoped packages, daily refresh): https://github.com/oven-sh/bun/blob/2596ac5d391d47804c93a42bdbe615804aa62387/test/cli/install/bunx.test.ts
- Bun issues: https://github.com/oven-sh/bun/issues/5846, https://github.com/oven-sh/bun/issues/9346, https://github.com/oven-sh/bun/issues/46596, https://github.com/oven-sh/bun/issues/47875
- npm docs, package.json (`bin`, `engines`): https://docs.npmjs.com/cli/v11/configuring-npm/package-json
- npm docs, scoped packages: https://docs.npmjs.com/cli/v11/using-npm/scope
