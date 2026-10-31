# Production artifact

`fleur build` writes one immutable artifact from the project's admitted source.
`fleur start --artifact <dir>` serves it through Bun and verified local Docker
isolation against PostgreSQL you configure. Fleur never provisions a production
database, and hosted deployment and authentication remain outside v1.

```sh
fleur build --json
FLEUR_PRIVATE_DATABASE_URL=... fleur db migration plan
FLEUR_PRIVATE_DATABASE_URL=... fleur start --artifact .fleur/artifacts/<id>
```

## Build

Build requires the same Docker readiness as `fleur dev`, and it is the only step
that acquires images. Each artifact is published atomically under
`.fleur/artifacts/<id>` and never overwritten. Delete old artifacts yourself.

| Path | Contents |
| --- | --- |
| `fleur-artifact.json` | Release, Bun, compiler and platform pins, image identities and a digest of every other file. |
| `supervisor/` | The bundled Bun supervisor with its dependencies. Serving reads nothing from source or an installed package. |
| `server/application.js` | The compiled application bundle, also inside the worker image. |
| `client/` | Immutable browser files and their index. |
| `manifest/` | The validated route, island and operation registry, and the exact runtime dependency versions. |
| `schema/migrations/` | The reviewed migration chain the artifact expects. |
| `images/execution.oci.tar` | The restricted worker and controller images for this architecture. |
| `docs/` | This release's local documentation. |

Secrets, `.env` files, machine configuration, development volumes, logs and caches
have no path into the artifact, because build writes only these named outputs.
A declaration change without a reviewed migration refuses with
`MIGRATIONS_PENDING`.

The archive matches the build machine's Docker architecture. An amd64 artifact
serves every required platform (Intel macOS, Ubuntu 24.04/26.04 and Debian 13).

## Start

Start checks, in order, and refuses with the stable code before serving:

1. The artifact is complete and matches its digests, before any of its code runs
   or Docker is contacted (`ARTIFACT_INVALID`). It matches this Fleur release, Bun
   and architecture (`ARTIFACT_INCOMPATIBLE`).
2. `FLEUR_PRIVATE_DATABASE_URL` is set (`CONFIGURATION_MISSING`).
3. The port is free. Production defaults to `127.0.0.1:3000` and never selects
   another port (`PORT_OCCUPIED`). One start per application runs on a machine
   (`ALREADY_RUNNING`).
4. Docker readiness passes, using the artifact's own image for the smoke
   container. The exact images are reused, or imported from the archive. Start
   never pulls, builds or installs anything.
5. The database is reachable and compatible: no pending migration, drift or
   uncertain maintenance (`DATABASE_UNAVAILABLE`, `MIGRATIONS_PENDING`,
   `SCHEMA_DRIFT`, `MAINTENANCE_BUSY`, `RECOVERY_REQUIRED`). Start never applies
   migrations; review and apply them explicitly.
6. Declared broker credentials are present in `FLEUR_RETRIEVAL_CREDENTIALS`
   (`CONFIGURATION_MISSING`).
7. The application registers as built and its routes, assets and reactive
   transport answer. `--timeout` bounds this; the first import of an archive can
   need more than the 60-second default.

Secrets enter only through the startup environment and stay in the trusted broker.
Fleur does not load `.env` files, including from the directory it is run in.
Execution containers receive none of them. There is no public configuration in
this release, so no configuration value reaches the browser.

Start runs in the foreground. `SIGINT`, `SIGTERM`, `SIGHUP` or the death of its
launcher drain for up to 30 seconds, then stop owned execution containers. A
crashed start needs an explicit restart. The imported images stay on the machine
for the next start and are removed with `docker image rm`.

`GET /__fleur/health` reports only `{"status":"available"}` (200) or
`{"status":"unavailable"}` (503). Development inspection endpoints and metadata do
not exist in production. Diagnostics go to stderr as fixed codes, with no
application data. `fleur status --production` from the project reports a live
start's state and URL with database health.
