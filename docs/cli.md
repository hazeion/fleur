# CLI foundation

The release package uses Bun 1.4.3 directly. Its executable is `bin/fleur.ts`, with a Bun shebang. Node and npm are not bootstrap requirements. The initial package version is 0.1.0; project creation will pin the release package version exactly. This foundation implements help and invocation validation only. It does not install prerequisites or run applications.

Run `bun bin/fleur.ts --help` for the available command catalog. `--json` returns one JSON version 1 object on stdout. Diagnostic logs belong on stderr. Every finite result contains `formatVersion`, `command`, `ok`, `data`, `error` and `truncated`. Successful results have `error: null`; failures have structured recovery actions and null data unless diagnostic partial data is explicitly documented.

Common options are `--project <dir>`, `--json`, `--timeout <seconds>` and `--help`. Paths resolve from the invocation directory. The default timeout is 60 seconds; an explicit timeout must be finite and positive. Duplicate, unknown and malformed options return exit 2. Commands are named operations; arbitrary shell arguments are rejected.

Exit categories are 0 success, 1 failure, 2 invalid invocation, 3 human authority or action required, 4 environment unavailable or incompatible, and 5 contention, drift or recovery blocking. Future command handlers return the same result contract through `runCli`; the executable owns stdout serialization. Help is generated from the same catalog used by dispatch.

Development checks are `bun test tests/cli`, `bun run types` and `bun run lint`. Packed tests create a real package archive, extract it outside the checkout and run its executable with a poisoned Node command and no package dependencies. The entry point is also exercised through actual `bunx --no-install fleur --help` after installing that owned archive into a temporary consumer project. Bun is on its isolated PATH and Node is poisoned. Nothing is published.
