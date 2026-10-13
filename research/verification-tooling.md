# Verification tooling research

Research for [#20](https://github.com/hazeion/fleur/issues/20), checked October 13, 2026. The [approved verification contract](https://github.com/hazeion/fleur/issues/11#issuecomment-6142000930) remains authoritative. This note records documentation and package metadata research. No package installation, compiler execution, browser launch, database integration, build, or compatibility benchmark was performed. Documentation research is complete. Mandatory executable compatibility validation belongs to the first authorized implementation slice; it is not evidence already obtained here.

## Candidate pins

Exact candidates, not a tested lockfile. Registry responses were fetched directly; package metadata and the TypeScript, tsc-rs, Oxlint, ESLint and Playwright entrypoint archives were inspected without executing their code.

| Tool | Candidate | Role and source |
|---|---|---|
| Bun | 1.4.3 | Runtime and test runner. [Release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3) |
| Microsoft TypeScript | 7.0.2 | Default application compiler. This is now the native compiler, not the older JavaScript implementation. [Package metadata](https://registry.npmjs.org/typescript/7.0.2) |
| tsc-rs | 0.6.0 | Experimental compiler, separately pinned from its upstream. [Release](https://github.com/pingdotgg/ts-rust/releases/tag/v0.6.0), [metadata](https://registry.npmjs.org/tsc-rs/0.6.0) |
| Microsoft comparison compiler | 7.1.0-dev.20261008.1 | Exact upstream reference for tsc-rs 0.6.0, not the stable default. [Release-specific README](https://github.com/pingdotgg/ts-rust/blob/v0.6.0/README.md#status) |
| Oxlint | 1.87.0 | Fast syntax/static lint. [Metadata](https://registry.npmjs.org/oxlint/1.87.0) |
| ESLint | 10.12.0 | Remaining rules and Fleur custom rule checks. [Metadata](https://registry.npmjs.org/eslint/10.12.0) |
| typescript-eslint | 8.71.2 | Typed ESLint rules. [Metadata](https://registry.npmjs.org/typescript-eslint/8.71.2) |
| TypeScript lint engine | 6.0.3 | Separate internal JavaScript compiler dependency for typescript-eslint. [Metadata](https://registry.npmjs.org/typescript/6.0.3) |
| Playwright Test | 1.64.0 | Browser suite, browser revisions tied to this package. [Metadata](https://registry.npmjs.org/@playwright/test/1.64.0) |
| PostgreSQL | 18.6 | Supported stable major/minor candidate. [Version policy](https://www.postgresql.org/support/versioning/) |
| Docker Engine | 29.9.0 | Production/development container candidate following #21. [Engine release](https://github.com/moby/moby/releases/tag/docker-v29.9.0) |
| Docker Compose | 5.6.0 | Candidate only if the chosen resource-management implementation uses Compose. [Release](https://github.com/docker/compose/releases/tag/v5.6.0) |

Pin the PostgreSQL image by manifest digest after verifying availability for both Linux architectures. No image digest was established here. Do not describe `postgres:18`, `latest`, or an unverified tag as an immutable pin. Obtain an exact Node LTS patch only if executed browser/lint compatibility makes Node necessary; no Node version is a new application runtime prerequisite from this research.

## Compiler boundaries

The release README identifies tsc-rs's upstream as Microsoft commit `fed0bf24149fb1ed36039212648bafdafc1ea10e`. Its CLI reports the upstream TypeScript version, not npm package 0.6.0. Record both. Published packages include macOS Intel/arm64 and Linux x64/arm64; upstream describes the Linux release binaries as static musl. These publication claims do not establish Fleur compatibility. [Release package construction](https://github.com/pingdotgg/ts-rust/blob/v0.6.0/npm/README.md).

The release documents differences for workspace source duplication and project builds without explicit references, plus editor memory growth. Avoid undocumented fast modes in equivalence gates. Check clean and incremental builds, watch edits, declaration output, and editor startup independently. A passing command-line check cannot prove language-server behavior. [Known problems](https://github.com/pingdotgg/ts-rust/blob/v0.6.0/README.md#known-problems).

Fixtures must prove schema-to-database inference, query/mutation/retrieval inputs and outputs, client import restrictions, server-only values, nullable fields, exact-decimal representation, and valid/invalid Bun plus Preact server-page/island boundaries selected through #21. Shared components must be safe in both environments; server-only functions and secrets must stay out of browser builds. Compare exit codes and normalized diagnostics with the exact upstream reference. Require expected rejection at the intended call site, not merely any error. Compare stable Microsoft separately; differences between 7.0.2 and the development reference are not automatically Rust defects. No silent compiler fallback. Keep selected checker, lint engines, build transpiler and editor server visible in diagnostics.

## Lint ownership

Oxlint supports built-in TypeScript rules and JS plugins, but JS plugins remain alpha and do not support custom parsers or rules needing TypeScript type information. Keep required Fleur custom checks in ESLint until their Oxlint equivalents pass independent conformance fixtures. Maintain a rule ownership table to avoid disabling a check in both tools. [JS plugin limits](https://oxc.rs/docs/guide/usage/linter/js-plugins).

The typescript-eslint support window currently ends below TypeScript 6.1. Native TypeScript 7 therefore cannot be substituted into its parser/type APIs. Put ESLint and TypeScript 6.0.3 in an internal tooling dependency graph where resolution finds that engine; application compiler selection remains independent. This is a compatibility gap to prove with installed resolution and actual fixtures. Do not silently prohibit otherwise approved TypeScript syntax to fit this older lint engine. Validate the intended strict TypeScript/Preact application fixtures against both engines as a release gate. If TS7 syntax or semantic changes cannot be linted correctly, report the exact discrepancy and resolve the tool integration or obtain an explicit contract decision; do not suppress warnings to claim compatibility. [Supported dependency versions](https://typescript-eslint.io/users/dependency-versions/).

Oxlint's optional type-aware engine is Go-based tsgolint, independent of both selected compilers. It can be evaluated later, but is not needed for the approved initial split. Its current package candidate is `oxlint-tsgolint@7.0.2004`. Do not replace Fleur's compiler gate with Oxlint `--type-check`. [Type-aware architecture](https://oxc.rs/docs/guide/usage/linter/type-aware), [metadata](https://registry.npmjs.org/oxlint-tsgolint/7.0.2004).

Editor/pre-commit feedback is optional. Full lint runs locally and in CI. Static checks do not enforce runtime capabilities; runtime enforcement remains a separate implementation and test obligation.

## Bun, browsers and platform coverage

`bunx` normally honors a Node shebang; invoking a package through Bun's package manager does not prove it ran on Bun. `bunx --bun` forces Bun execution. Test the local package entrypoint directly so cached/downloaded packages cannot change the experiment. [Bun launcher behavior](https://bun.com/docs/pm/bunx).

Playwright documents Node and macOS 14+, Debian 12/13, and Ubuntu 22.04/24.04/26.04 on x64/arm64. Arch is absent from its supported host list. Recommend a supported Ubuntu/Debian container for Arch browser tests if host execution fails, but that requires a concrete tested wrapper and explicit documentation. Ordinary Bun runtime support does not imply browser-binary support. [Playwright requirements](https://playwright.dev/docs/intro#system-requirements).

Bun publishes macOS Intel/arm64 and Linux x64/arm64 binaries, with macOS 13 minimum and Linux libc/CPU requirements. Fleur's full browser-testing baseline must also satisfy Playwright. Cover macOS Intel and arm64, Ubuntu and Debian on both architectures, and an identified Arch snapshot for runtime/install smoke checks. Choose actual OS images in final assembly; no blanket “Linux verified” claim follows from one Ubuntu runner. [Bun installation requirements](https://bun.com/docs/installation).

## Proposed executable checks, unexecuted

The package paths below were confirmed by inspecting each candidate package archive and its bin metadata. These commands are recipes after locked dependencies and real fixture files exist. They are not current repository commands or evidence of passes.

```sh
bun install --frozen-lockfile
bun test tests/unit
bun test tests/integration
bun node_modules/typescript/bin/tsc --noEmit -p tests/types/valid/tsconfig.json
bun node_modules/tsc-rs/bin/tsc-rs --noEmit -p tests/types/valid/tsconfig.json
bun node_modules/oxlint/bin/oxlint .
bun node_modules/eslint/bin/eslint.js .
bun node_modules/@playwright/test/cli.js install chromium
bun node_modules/@playwright/test/cli.js test --project=chromium
```

Run the same Playwright fixture with a pinned Node executable if Bun fails, recording each launch result. Installation of browser OS dependencies uses a separately authorized provisioning step. Test worker subprocesses, reporters, traces, restart/reconnect, two-view updates and failures; `--version` alone is insufficient. Run negative compiler fixtures individually and require specific diagnostics. Install the upstream comparison compiler in a separate fixture directory so it cannot replace the project's compiler or lint engine.

PostgreSQL integration setup must create a uniquely owned disposable container/database and role, verify its identity before writes, and reject development/production URLs. Include real transactions, contention, drift, backup/restore and crash recovery. Remove only resources carrying that run's ownership identity. Use controlled external API fixtures and unique browser contexts. [PostgreSQL transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html), [Playwright isolation](https://playwright.dev/docs/browser-contexts).

Once command contracts exist, CI exercises generated projects through `fleur test`, `types`, `lint`, `build`, and `verify`. Packed CLI tests install a produced tarball into a disposable directory with Node unavailable, exercise `bunx fleur` bootstrap and pinned-project invocation, validate stdout JSON/stderr separation, and test missing Docker/authorization states. Following #21, production proof starts the built artifact through Bun with Docker available for restricted handler execution, against isolated PostgreSQL with package installation disabled and required secrets supplied only at startup. Verify container filesystem/network restrictions and broker authorization independently; the existence of Docker does not prove isolation. Docker Desktop versions on macOS and Engine package versions on each Linux target require separate recorded pins; Moby release metadata alone does not establish those installer versions. Browser checks verify saved data, server-rendered updates, rejection, conflicts and persistence.

## Decisions and remaining evidence

Tool direction is approved. Candidate versions are engineering recommendations, not verified support. Assembly must choose exact OS support, an Arch browser-testing path, and the separate lint-engine packaging strategy. The existing permission to use Node covers browser testing when Bun fails; requiring Node for full generated-project lint would be a new prerequisite needing human discussion if Bun execution cannot pass. Bun plus Preact server pages/islands is the current rendering direction; React RSC compatibility is not required unless a later decision replaces it. Experimental Rust selection remains unavailable until its gates pass; this is already approved rather than permission to ship unchecked compatibility.

Issue #20 can close as documentation research complete. The first authorized implementation slice must validate package installation and launch on supported OS/architecture targets, the separate lint-engine resolution, compiler positive/negative equivalence, browser workers and binaries, packed CLI startup, PostgreSQL identity/isolation, and Docker production enforcement. Failures block release or require explicit contract revision. No experimental compiler selection ships before its mandatory checks pass. Preserve this distinction in final assembly: exact candidate versions and required release tests are specified; support has not been executed or verified.
