# Rendering compatibility experiment

Disposable subset of [Prove compatibility and runtime isolation](https://github.com/hazeion/fleur/issues/23). This fixture exercises the approved specification's HTTP HTML, island props, browser refresh, and production browser artifact boundaries. It does not implement Fleur APIs or satisfy the whole compatibility gate.

## Run

Use Bun 1.4.3 on PATH. Run from this directory, with the separate lint dependency graph installed as well:

```sh
bun install --frozen-lockfile
cd lint
bun install --frozen-lockfile
cd ..
bun ./node_modules/@playwright/test/cli.js install chromium
bun run build
bun run types
bun run lint
bun run test
bun run browser
bun run browser
```

Browser installation downloads the package's exact browser revision. Tests refuse to reuse an existing server on loopback port 43287. An occupied port fails the fixture. Builds, browser reports and installed packages remain ignored.

## Executed October 13, 2026

The initial local experiment observed macOS 15.7.7, build 24G720, reporting x86_64; translation-state queries were unavailable in that early run. The final PR matrix later verified native Intel and Apple Silicon macOS 15.7.9, plus Ubuntu 24.04/26.04 on both architectures. All rendering checks and both browser runs passed on those hosts and the three distribution userspaces in [run 38455482128](https://github.com/hazeion/fleur/actions/runs/38455482128). See the [durable evidence matrix](../evidence.md). Bun 1.4.3 reports revision c6da4a4d3. Its archive digest verification belongs to the adjacent tooling experiment. No Node runtime was used for these commands.

Exact candidates frozen in the two Bun lockfiles:

| Dependency | Version |
| --- | --- |
| Preact | 11.0.1 |
| preact-render-to-string | 6.8.0 |
| Zod | 4.6.7 |
| Vite | 8.3.4 |
| Playwright Test | 1.64.0 |
| Bun types | 1.4.3 |
| Microsoft TypeScript | 7.0.2 |
| Oxlint | 1.87.0 |
| ESLint | 10.12.0 |
| typescript-eslint | 8.71.2 |
| Separate ESLint TypeScript engine | 6.0.3 |

Playwright downloaded and launched its Chromium headless shell revision 1248, version 156.0.8078.4. The system browser was not used. Bun launched the Playwright CLI, test worker and fixture server.

Both frozen installations passed. Strict TypeScript checking passed without skipLibCheck. Oxlint and ESLint recommended TypeScript rules passed. These are experiment lint checks; Fleur's remaining custom admission rules are not implemented here. Vite's production browser build passed. Four Bun tests passed with 20 assertions. All three Playwright tests passed on each of two consecutive final runs.

Observed behavior:

- Initial HTTP HTML includes the server-rendered name and island markup before browser execution. Server rendering runs zero client effects. Initial hydration runs one effect.
- Zod validates public props before server delivery, initial hydration and refresh. Declared props pass. Unknown fields, nested unsupported values, dates, bigint, unsafe integers, undefined and nonfinite numeric values fail the tested schema. Corrupt initial props do not hydrate. Corrupt refresh props preserve the previous server content and island.
- A refreshed server-rendered name and validated island props update while an unsubmitted draft, focused input and mounted effect identity survive.
- Browser chunks and their source maps contain admitted client/island/props sources and exclude the fixture's server module, server-only function name and fake secret canary. Injecting each canary into either a chunk or a source map causes the artifact verifier to reject it.

Requirements-based red evidence preceded implementation. The valid-props test failed because the placeholder validator rejected a valid object. The HTTP test failed because the placeholder server returned no server-rendered name. The artifact verifier's negative test failed because a placeholder accepted forbidden content. The first complete browser run found an ambiguous status locator, which was corrected with an accessible name. The first type check identified missing explicit Bun types, nullable captured DOM references and an obsolete Vite esbuild option; the corrected fixture uses Vite's typed Oxc JSX option.

Final emitted artifact SHA-256 values, with generated files left untracked:

```text
client.js      27f2d05596539727d4954087f0979ea4b564a439f0fd53a9a1bffddc89b666bd
client.js.map  6b59bcf795667116833430b377dc897ccde1215a229a11810b2757036a06e128
```

## Limits

This is a specific single-region fixture. Its explicit island root and separately replaced server span demonstrate a viable Preact reconciliation mechanism. It does not prove generic keyed/nested region compilation, island admission manifests, arbitrary lazy graph exclusion, route changes, server query authority, revision/epoch ordering, subscriptions or two-view database updates. The artifact scanner checks this fixture's canaries; it is not a security admission implementation.

The trusted Bun server uses ordinary filesystem/network authority. There is no restricted worker, broker, database, production Docker artifact or isolation guarantee in this fixture. The browser deliberately fetches a fixture-owned response directly; that is not an application transport API. The supported experiment matrix is recorded in [evidence.md](../evidence.md); Debian/Arch are container-userspace checks rather than native host installation proofs. Effective restricted-container configuration and an actual CPU-busy worker deadline/healthy-worker proof remain open at the aggregate gate. Passing this rendering subset alone does not enable dependent implementation.
