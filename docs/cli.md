# CLI foundation

The release package uses Bun 1.4.3 directly. Its executable is `bin/fleur.ts`, with a Bun shebang. Node and npm are not bootstrap requirements. The initial package version is 0.1.0; project creation pins the release package version exactly. The current catalog implements help, `new`, `init`, `doctor`, `setup`, `setup grants list` and `setup grants revoke <id>`. Setup supports scoped authorized smoke-image acquisition. It does not install Docker packages or run applications.

Run `bun bin/fleur.ts --help` for the available command catalog. `--json` returns one JSON version 1 object on stdout. Diagnostic logs belong on stderr. Every finite result contains `formatVersion`, `command`, `ok`, `data`, `error` and `truncated`. Successful results have `error: null`; failures have structured recovery actions and null data unless diagnostic partial data is explicitly documented.

Common options are `--project <dir>`, `--json`, `--timeout <seconds>` and `--help`. Paths resolve from the invocation directory. The default timeout is 60 seconds; an explicit timeout must be finite and positive, at most 2,147,483 seconds. Duplicate, unknown and malformed options return exit 2. Commands are named operations; arbitrary shell arguments are rejected.

Exit categories are 0 success, 1 failure, 2 invalid invocation, 3 human authority or action required, 4 environment unavailable or incompatible, and 5 contention, drift or recovery blocking. Future command handlers return the same result contract through `runCli`; the executable owns stdout serialization. Human and JSON help are generated from the same catalog used by dispatch, including each implemented command's admitted flags. Asking for command help does not run that command.

Development checks are `bun test tests/cli`, `bun run types` and `bun run lint`. Packed tests create a real package archive, extract it outside the checkout and run its executable with a poisoned Node command and no package dependencies. The entry point is also exercised through actual `bunx --no-install fleur --help` after installing that owned archive into a temporary consumer project. Bun is on its isolated PATH and Node is poisoned. Nothing is published.


Project commands read `fleur.json` as bounded data and require an exact `fleurVersion`. A configured project with a missing, malformed or incompatible pin returns exit 4 with `VERSION_MISMATCH` before project writes. If `fleur.json` is missing, the application marker in `package.json` identifies the existing Fleur project and blocks descendant creation as well. That marker never supplies a fallback pin; ordinary manifests and the CLI package name alone do not identify a configured application. Fresh `new` and `init` outside configured projects use the package release version. An existing project with that same version needs no separate local install, but must declare format version 1, contract version 1 and the Microsoft compiler. Missing or unsupported metadata blocks project writes. Different exact releases are delegated before applying the current release's metadata rules. A different exact pin delegates only to the matching installed `node_modules/fleur` package, through Bun, after checking its package name, version and contained executable. Missing installations, escaped executable paths and delegation loops stop with an explicit recovery action. No latest-version or network fallback is used. Help remains available when metadata is broken.

Ordinary interruption of a delegated launcher forwards SIGINT, SIGTERM or SIGHUP to its owned child and waits for that child to exit. The caller receives the child's actual completion status. A graceful stop that finishes successfully returns 0; a child terminated by a signal returns that signal-derived status. A child that ignores interruption receives a 30-second grace period before forced termination and reaping, which returns 137 for SIGKILL. An uncatchable kill of the launcher cannot provide this cleanup guarantee. Help, prerequisite diagnosis and per-user grant inspection or revocation remain available independently of project pins.


The package includes this document, project creation guidance and prerequisite setup guidance for offline reading. `docs` is not yet an implemented command. Generated projects contain working pinned test, type and lint tooling; this is separate from a Fleur application build or native installation proof. CI verifies the complete CLI suite and both compiler/lint graphs, then creates and checks a fresh packed project twice with separate dependency caches.

## Initial error catalog

| Code | Exit | Recovery |
| --- | --- | --- |
| `ARGUMENT_INVALID` | 2 for invalid invocation; 1 when a requested grant does not exist | Read help or list existing grants before retrying. |
| `INTERNAL_FAILURE` | 1 | Inspect the failed operation; no success is reported. |
| `PROJECT_CREATION_FAILED` | 1 | Correct the failure and retry after confirmed rollback. |
| `VERSION_MISMATCH` | 4 | Restore intended exact metadata or explicitly install the matching local release. |
| `PREREQUISITE_UNAVAILABLE` | 4 for unavailable or incompatible prerequisites; 1 for a failed authorized acquisition | Run doctor and inspect required setup actions. |
| `READINESS_TIMEOUT` | 4 | Recheck prerequisites before explicitly retrying. |
| `AUTHORITY_REQUIRED` | 3 | Have a human inspect and authorize the exact proposed action. |
| `HUMAN_ACTION_REQUIRED` | 3 | Complete the documented manual prerequisite action, then rerun setup. |
| `PROJECT_COLLISION` | 5 | Choose an empty target or resolve reported protected files explicitly. |
| `MAINTENANCE_BUSY` | 5 | Wait for the current setup operation to finish. |
| `RECOVERY_REQUIRED` | 5 | Inspect reported incomplete restoration or unsafe state before retrying. |

Doctor and setup may return documented partial diagnostic data on failure, including component states, resumable plans and completed setup actions. A nonzero readiness result never claims a verified native release profile. Per-user grant inspection and revocation do not install or remove software.

## Bun compatibility

The selected Fleur release requires the exact Bun version published in its package `engines.bun` metadata, currently `1.4.3`. Valid non-help commands reject a different invoking version with exit 4 and `BUN_VERSION_MISMATCH`, including expected and actual versions plus manual installation guidance. Fleur does not upgrade or replace Bun. Help remains available, and invalid command syntax retains its argument-error result.

Project pin resolution and exact local release delegation happen before the launcher's own compatibility check. A delegated release enforces its own requirements; a newer temporary launcher cannot impose its Bun requirement on that older selected release.

The compatibility regression uses a real checksum-verified Bun 1.4.2 release executable in an owned temporary directory, rather than overriding the runtime-reported version. Its setup downloads only the fixed official asset and extracts its expected executable through `/usr/bin/unzip`; tests also require `/usr/bin/tar` for the packed CLI. This is explicit development-test acquisition, outside command startup/deadline measurements, and is cleaned afterward. Ordinary Fleur execution still requires only Bun. Asset identities are pinned for Linux/macOS x64/arm64; only platforms that actually run the test provide execution evidence, and the negative runtime is not admitted as supported.
