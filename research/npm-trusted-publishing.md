# npm trusted publishing with provenance for `@hazeion/fleur`

Date: 2026-11-09. Resolves Wayfinder research ticket #174 (map #160, blocks #170).

## Question

What does it take to publish `@hazeion/fleur` from a tagged GitHub Actions
workflow using npm trusted publishing (OIDC) with provenance attestations and
no long-lived token? Registry-side configuration for a user scope versus an
org scope; whether `bun publish` supports trusted publishing and provenance or
whether npm's CLI is required; exact workflow permissions; how `prepack` and
the `files` list interact; how to verify the published tarball matches the
GitHub release asset; cost and runner requirements.

## Summary answer

- Trusted publishing is configured per package on npmjs.com, after the package
  exists. The GitHub Actions form takes "Your GitHub username or organization
  name", repository, workflow filename and an optional environment name, so a
  user-owned scope (`@hazeion`) works the same as an org scope. The first
  version must be published another way (local `npm publish --access public`
  with 2FA, or `npm stage publish`), and a new trusted-publisher configuration
  expires if it does not complete a publish within 2 days.
- `bun publish` cannot do this: Bun's docs say it "cannot generate provenance
  statements yet" and that every provenance flag is an error; its documented
  authentication is `NPM_CONFIG_TOKEN`/`.npmrc` only. Use Bun to pack and npm
  CLI >= 11.5.1 (>= 11.15.0 for staging) on Node >= 22.14.0 to publish the
  tarball: `bun pm pack` then `npm publish ./hazeion-fleur-<v>.tgz`.
  Provenance is then automatic (OIDC claims + public repo + public package).
- Workflow permissions: `id-token: write` plus `contents: read` for the publish
  step; `attestations: write` if the tarball is also attested with
  `actions/attest`; `contents: write` to create the GitHub release (prefer a
  separate job). GitHub-hosted runners only.
- `bun pm pack` runs `prepack`, `prepare`, `postpack` and sets `npm_execpath`
  to the Bun binary, so Fleur's `prepack` (tsc declarations into
  `dist/reference`) runs under the pinned Bun and `files` picks the output up
  even though `dist/` is gitignored. `npm publish <tarball>` runs no scripts and
  keeps the tarball bytes, so `dist.integrity` on the registry is the sha512 of
  the exact file Bun produced.
- Verification: the same tarball file is (1) the npm `dist` tarball, whose
  `dist.integrity` is `sha512-<base64>` of its bytes and whose registry
  attestations name `pkg:npm/@hazeion/fleur@<v>` with that sha512; (2) the
  subject of a GitHub artifact attestation (`gh attestation verify`); and (3) a
  release asset with a GitHub-computed `digest`, verifiable with
  `gh release verify-asset` once immutable releases are enabled.
- Cost: standard GitHub-hosted runners are free for public repositories; a
  release job is a few Linux minutes (billable rate would be $0.006/min on a
  private repo). npm public packages are free. Fleur's package.json currently
  has no `repository` field, which trusted publishing requires to match the
  repository exactly.

## Findings

### 1. Registry-side configuration: user scope versus org scope

- npm grants "a scope that matches your user or organization name" at sign-up
  or org creation. Scoped packages are private by default and need
  `--access public` on publish. [npm: About scopes][scopes]
- Publishing user-scoped packages requires only an npm user account;
  org-scoped packages additionally require creating an npm organization.
  [npm: Creating and publishing scoped public packages][scoped-public]
- Trusted publisher setup is in the package settings on npmjs.com
  ("Trusted Publisher" section). The GitHub Actions fields are: Organization or
  user ("Your GitHub username or organization name", required), Repository
  (required), Workflow filename (required, filename only, `.yml`/`.yaml`
  extension, in `.github/workflows/`), Environment name (optional), Allowed
  actions (optional). "All fields are case-sensitive and must be exact." Up to
  10 trusted publishers per package; existing connections cannot be edited,
  only deleted and recreated. [npm: Trusted publishers][tp]
- The GA announcement states support for "all npm private and public
  packages, both scoped and unscoped" and names the field "organization/user";
  neither source distinguishes user from org behaviour. [GitHub changelog
  2025-07-31][ga]
- npm does not validate the configuration when saved; errors appear at publish
  time. "A newly created trusted publisher configuration must complete its
  first successful publish within 2 days", otherwise "it expires and can no
  longer be used or edited." [tp]
- First publish: the docs route configuration through an existing package's
  settings and describe no flow for a package that does not exist yet. Staged
  publishing does work for new packages: npm publishes a public placeholder
  version `0.0.0-stage` and keeps the staged version private until approval.
  [npm: Staged publishing][stage] A plain first publish from a maintainer
  machine (`npm publish --access public` with 2FA, or `bun publish --access
  public` with 2FA) is the other documented path. [scoped-public]
- Allowed actions: "`npm stage publish` is always allowed"; direct
  `npm publish` and `npm dist-tag` are optional and "Allow npm dist-tag" is
  disabled by default. Stage list/view/approve/reject "require interactive
  authentication and cannot use OIDC tokens." Recommended package setting:
  "Require two-factor authentication and disallow tokens" (affects token auth
  only; OIDC keeps working). [tp]
- Staged publishing: `npm stage publish` does not require 2FA; approval
  (`npm stage approve <stage-id>` or npmjs.com) does, and it can be combined
  with trusted publishing. Requires npm CLI >= 11.15.0 and Node >= 22.14.0.
  [stage]
- Token landscape: "As of November 2025, only Granular access tokens are
  supported"; "Legacy access tokens have been removed"; direct publishing with
  granular tokens is being removed in January 2027; "For CI/CD publishing,
  consider adopting trusted publishing instead." [npm: About access
  tokens][tokens]
- `repository.url` in `package.json` "must exactly match your GitHub
  repository" (listed under troubleshooting). Fleur's package.json has no
  `repository` field today (`package.json` in this repository). [tp]

### 2. `bun publish` versus npm CLI

- Bun docs: "`bun publish` cannot generate provenance statements yet."
  "`--provenance`, `--provenance-file`, `"provenance": true` in
  `publishConfig`, `NPM_CONFIG_PROVENANCE=true` and `provenance=true` in
  `.npmrc` are errors"; only `--no-provenance` is accepted. Documented
  authentication is `NPM_CONFIG_TOKEN` ("useful when publishing from GitHub
  Actions") or an `.npmrc` `_authToken`; OIDC and trusted publishing are not
  mentioned. [Bun: bun publish][bun-publish]
- Observed locally with Bun 1.4.4: `bun publish --dry-run --provenance` fails
  with `error: --provenance is not supported yet: bun publish cannot generate
  provenance statements`; `bun publish --dry-run ./tarball.tgz` without a
  token fails with `error: missing authentication (run \`bunx npm login\`)`.
- The upstream feature request "Implement `bun publish --provenance` as in
  npm" is open (oven-sh/bun#15601, checked 2026-11-09). [bun-15601]
- npm CLI: trusted publishing requires "npm CLI 11.5.1 or later, and Node
  22.14.0 or higher"; dist-tag management via OIDC needs 11.21.0+ or 12.2.0+.
  Provenance is "automatic for GitHub Actions and GitLab CI/CD, with no
  `--provenance` flag needed", only "when publishing from a public repository
  and publishing a public package." [tp]
- npm CLI source (`lib/utils/oidc.js`): OIDC runs only when `ci-info` detects
  GitHub Actions, GitLab or CircleCI; on GitHub it requires both
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
  (otherwise "Skipped because incorrect permissions for id-token"), requests
  the ID token with audience `npm:<registry host>`, POSTs it to
  `/-/npm/v1/oidc/token/exchange/package/<escaped name>` and installs the
  returned short-lived token for the command. Provenance is auto-enabled only
  when the `provenance` config is at its default, no `--provenance-file` is
  given, the ID token's `repository_visibility` is `public`, and the registry
  reports the package public. [npm/cli oidc.js][oidc-js]
- `libnpmpublish` computes `dist.integrity` (sha512) and `dist.shasum` (sha1)
  from the tarball bytes it is given, uses `{ sha512 }` of those bytes as the
  provenance subject digest with name `pkg:npm/...`, and refuses provenance
  for a new or private package unless `--access public` is set ("Can't
  generate provenance for new or private package, you must set `access` to
  public."). [npm/cli publish.js][publish-js]
- Publishing a tarball: npm accepts "a gzipped tarball containing" a package
  folder (relative paths start with `./`). `--provenance-file` takes
  precedence over automatic generation and cannot be combined with
  `--provenance`. [npm: npm publish][npm-publish] Bun likewise documents
  `bun pm pack` then `bun publish ./package.tgz`. [bun-publish]
- Running npm on the runner: the `ubuntu-24.04` image (version 20261101.360.1)
  ships Node 22.23.4 with npm 10.9.9, below the 11.5.1 floor; Node 24.22.2 is
  in the cached tools. [runner-images Ubuntu 24.04][runner-image] Node 24.22.2
  bundles npm 11.19.1 and Node 22.23.4 bundles npm 10.9.9 (nodejs.org
  `dist/index.json`, read 2026-11-09). Options: `actions/setup-node` with Node
  24 (npm's own example uses `actions/setup-node@v6`, `node-version: '24'`,
  `registry-url: 'https://registry.npmjs.org'`, `package-manager-cache:
  false`) [tp]; or `bunx npm@<pinned 11.x> publish ./tarball.tgz`, which runs
  npm's `#!/usr/bin/env node` bin with the system Node because "If an
  executable is marked with `#!/usr/bin/env node`, Bun spins up a `node`
  process to execute the file." [Bun: bunx][bunx] (the image's Node 22.23.4
  satisfies npm's >= 22.14.0 requirement).

### 3. Workflow permissions and GitHub OIDC

- "Without `id-token: write`, the OIDC JWT ID token cannot be requested." The
  permission only enables fetching the token. Token claims include
  `repository`, `repository_owner`, `repository_id`, `repository_owner_id`,
  `workflow`, `workflow_ref`, `job_workflow_ref`, `ref`, `ref_type`,
  `environment` (present only when the job uses one), `runner_environment`
  (`github-hosted` or `self-hosted`), `event_name`, `actor`. Default `sub` is
  `repo:OWNER/REPO:environment:NAME` (or `...:ref:refs/heads/BRANCH`);
  repositories created after 2026-07-15 use an immutable format with owner and
  repository IDs. [GitHub: OIDC reference][oidc-ref]
- npm's example workflow sets `permissions: id-token: write` and
  `contents: read`, triggers on `push: tags: ['v*']`, runs on `ubuntu-latest`.
  "The critical requirement is the `id-token: write` permission". [tp]
  Provenance docs repeat `id-token: write` and a GitHub-hosted runner.
  [npm: Generating provenance statements][prov]
- Self-hosted runners are not supported ("planned for future releases"). For
  reusable or `workflow_dispatch`-triggered workflows, validation "checks the
  calling workflow's name", and `id-token: write` must be set in both parent
  and child workflows. [tp]
- The trusted-publisher binding is by workflow filename (plus optional
  environment), not by ref. Any ref that carries a same-named workflow can
  request the token. Ref gating comes from GitHub: a job that references an
  environment "must follow any protection rules for the environment"; rules
  include "Selected branches and tags" name patterns, required reviewers (up
  to 6, one approval suffices, optional "Prevent self-review"), wait timers,
  and the option to deny administrator bypass. "Users with GitHub Free plans
  can only configure environments for public repositories." [GitHub: Manage
  environments][envs] Rulesets add "Restrict creations" ("only users with
  bypass permissions can create branches or tags whose name matches the
  pattern"), "Restrict updates" and "Restrict deletions" for tag patterns.
  [GitHub: Available rules for rulesets][rules]
- `push` tag filters: "You can use the `tags` or `tags-ignore` filter";
  "Events will not be created for tags when more than three tags are pushed at
  once." `release` activity `published` fires for both releases and
  pre-releases; `GITHUB_SHA` is the "Last commit in the tagged release".
  [GitHub: Events that trigger workflows][events]
- Artifact attestations (optional second attestation of the same tarball):
  `actions/attest` needs `id-token: write` ("mint the OIDC token"),
  `attestations: write` ("persist the attestation"), `contents: read`;
  `subject-path` may be a glob or list (<= 1024 subjects); outputs
  `bundle-path`, `attestation-id`, `attestation-url`. Public repos sign with
  the Sigstore public-good instance; private or internal repos require GitHub
  Enterprise Cloud. `actions/attest-build-provenance` v4 "is simply a wrapper
  on top of `actions/attest`" and "new implementations should use
  `actions/attest` instead." [actions/attest README][attest]
  [actions/attest-build-provenance README][abp] Attestations on their own are
  "SLSA v1.0 Build Level 2"; for public repositories "A copy of the generated
  Sigstore bundle is stored with GitHub and is also written to an immutable
  transparency log." [GitHub: Artifact attestations concept][attest-concept]

### 4. `prepack`, `files` and the Bun/npm pack boundary

- npm lifecycle order: `npm publish` runs `prepublishOnly`, `prepack`,
  `prepare`, `postpack`, `publish`, `postpublish`; `npm pack` runs `prepack`,
  `prepare`, `postpack`. [npm: scripts][scripts] Bun: "`bun publish` does not
  run lifecycle scripts ... if you provide a tarball path. Scripts run only
  when `bun publish` packs the package itself"; `bun pm pack --ignore-scripts`
  skips "pre/postpack and prepare scripts". [bun-publish] [Bun: bun pm][bun-pm]
- Observed locally (Bun 1.4.4, npm 11.19.1 on Node 24.22.1, scratch package
  `@hazeion/fleur-probe` with `files: ["bin","src","dist/reference"]`, a
  `prepack` that writes `dist/reference/index.d.ts`, and a gitignored
  `src/secret.log`):
  - `bun pm pack` ran `prepack`, `prepare`, `postpack` in that order and set
    `npm_execpath=/Users/.../.bun/bin/bun`; `npm pack` ran the same three with
    `npm_execpath=.../npm/bin/npm-cli.js`. Fleur's `prepack`
    (`"$npm_execpath" ./node_modules/typescript/bin/tsc -p
    tsconfig.declarations.json`) therefore runs tsc under Bun when Bun packs.
    Under npm it would hand the tsc path to `npm-cli.js` instead; publishing
    the Bun-built tarball avoids ever running `prepack` under npm.
  - Both tools produced the same five-file list (including the generated
    `dist/reference/index.d.ts` despite `dist/` being gitignored, and
    `src/secret.log` despite `*.log` in `.gitignore`: `files` directory entries
    are included wholesale). Both fix tar entry mtimes to 1985-10-26. The two
    tarballs are not byte-identical (sha256 `444d1a5e...` vs `a2e132b4...`;
    shasum `2ee9cc89...` vs `e2e601c8...`), so the attested file must be the
    very file that is published. Two consecutive `bun pm pack` runs gave the
    same sha256.
  - `npm publish --dry-run ./<bun tarball>` ran no lifecycle scripts and
    reported exactly the Bun tarball's shasum and integrity;
    `npm publish --dry-run` from the directory ran `prepublishOnly`,
    `prepack`, `prepare`, `postpack` and produced npm's own tarball.
  - Scoped output filename is `hazeion-fleur-probe-0.1.0.tgz` from both tools;
    `bun pm pack --quiet` prints just the path (`TARBALL=$(bun pm pack
    --quiet)` per Bun docs [bun-pm]); Bun also prints `Shasum` and
    `Integrity`. `openssl dgst -sha512 -binary <tgz> | base64` equals the
    printed `Integrity` value.
- Fleur itself: `bun pm pack --dry-run` in this worktree ran the `prepack`
  tsc step, produced `dist/reference/{client,database,routing,schema,server}.d.ts`
  plus `runtime/`, and would pack 238 files (1.93 MB unpacked) as
  `fleur-0.1.0.tgz` under the current unscoped name. `bun install
  --frozen-lockfile --ignore-scripts` must precede packing because `prepack`
  needs the `typescript` devDependency.
- npm's inclusion rules: with a `files` list "only the files specified will be
  included"; package.json and README are always included; symbolic links are
  never included. [npm-publish] Bun documents `bun pm pack` as "following the
  same rules as `npm pack`." [bun-pm]

### 5. Verifying tarball == release asset

- Registry side: `dist.integrity` is `sha512-<base64 of tarball bytes>` and
  `dist.shasum` is its sha1 [publish-js]; `npm view <pkg>@<version>
  <field>` supports dot notation and `--json`. [npm: npm view][npm-view]
  `dist.attestations.url` points at
  `https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>`, which
  returns two Sigstore bundles: a publish attestation (predicate
  `https://github.com/npm/attestation/tree/main/specs/publish/v0.1`) and a
  SLSA provenance (`https://slsa.dev/provenance/v1`, buildType
  `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1`,
  builder `https://github.com/actions/runner/github-hosted`), both with
  subject `pkg:npm/<name>@<version>` and the tarball's sha512 (observed on
  `sigstore@5.0.1`, 2026-11-09). Consumers run `npm audit signatures`, which
  "will also verify the provenance attestations of downloaded packages";
  `--json --include-attestations` emits the bundles. [npm: npm audit][audit]
- GitHub side: release assets get a SHA256 digest "generated at upload time,
  immutable", shown in the UI, REST, GraphQL and `gh`. [GitHub changelog
  2025-06-03][digests] The REST release-asset schema has a required
  `digest` (string or null) field. [GitHub REST: release assets][rest-assets]
- Immutable releases: "releases where the assets and associated Git tag cannot
  be changed after publication"; creating one generates "a cryptographically
  verifiable record of a release containing the release tag, commit SHA, and
  release assets"; create as a draft, attach assets, then publish. Enabled
  under repository Settings > Releases > "Enable release immutability";
  applies to future releases only. Verify with `gh release verify RELEASE-TAG`
  (exists and is immutable) and `gh release verify-asset RELEASE-TAG
  ARTIFACT-PATH` (asset digest "matches the subject in the attestation" and
  the attestation is tied to the release); the auto-generated source archives
  cannot be verified this way. [GitHub: Immutable releases][immutable]
  [GitHub: Prevent release changes][prevent] [GitHub: Verify release
  integrity][verify-release] [gh release verify-asset][gh-verify-asset]
- Artifact attestation side: `gh attestation verify <file> -R owner/repo`
  with `--signer-workflow`, `--source-ref`, `--cert-identity`,
  `--deny-self-hosted-runners`, `--format json`; `--repo`/`--owner` is
  required at minimum; default predicate type `https://slsa.dev/provenance/v1`.
  Only `signature.certificate` and `verifiedTimestamps` in the JSON "cannot be
  manipulated" by the originating workflow. [gh attestation
  verify][gh-attest-verify]
- Chain for Fleur: one `bun pm pack` output file is (a) attested by
  `actions/attest` (subject sha256), (b) published by `npm publish ./file`
  (registry records sha512/sha1 of the same bytes and attaches npm provenance
  with that sha512), (c) uploaded as the release asset (GitHub records its
  sha256; immutable-release attestation lists it). A verifier downloads the
  release asset and the registry tarball (`dist.tarball`), checks their
  sha256/sha512 agree with `digest`, `dist.integrity` and both attestation
  subjects, and runs `gh attestation verify`, `gh release verify-asset` and
  `npm audit signatures`.

### 6. Cost and runner requirements

- GitHub-hosted standard runners in public repositories are free ("remains
  free independently and does not reduce the included compute usage"); the
  Free plan otherwise includes $12/month of compute; Linux 2-core x64 is
  $0.006/min, macOS $0.062/min. [GitHub: Billing for Actions][billing]
  `hazeion/fleur` is public (`gh repo view`, 2026-11-09). A publish job
  (checkout, floor Bun, `bun install`, `bun pm pack`, attest, `npm publish`,
  release upload) is a few Linux minutes; one `ubuntu-24.04` job is enough,
  no macOS runner is involved.
- Trusted publishing and provenance require GitHub-hosted runners (no
  self-hosted) and a public source repository for provenance. [tp] [prov]
  Artifact attestations in private or internal repositories require GitHub
  Enterprise Cloud. [abp] Environments on Free are public-repo only. [envs]
- npm: Free tier publishes unlimited public packages (npmjs.com/pricing;
  fetch returned 403 here, so this rests on the pricing page as reported by
  search, not a quoted primary page).
- Fleur CI policy interactions (docs/ci.md, tests/ci): a new workflow file
  requires full verification once; `tests/ci/workflows.test.ts` requires every
  job in the listed workflows to install the floor Bun via
  `experiments/compatibility/platforms/bootstrap.py` before any `bun` step,
  forbids `setup-bun`/`bun-version`/`bun.sh/install`, and iterates a fixed
  list `["cli", "native-setup", "compatibility"]` whose first test demands a
  `pull_request` trigger plus `scope`/`verification` jobs. A tag-triggered
  release workflow does not fit that shape, so adding it means deciding how
  the wiring tests cover it (extend the Bun-floor test to the new file, and
  decide whether the scope/verification shape applies). Checkouts keep
  `persist-credentials: false`; Node/npm would be a new runtime in CI, pinned
  like other actions by commit SHA.

## Recommendation sketch (for the decision ticket, not a build authorization)

1. Rename to `@hazeion/fleur`, add `"repository": {"type": "git", "url":
   "git+https://github.com/hazeion/fleur.git"}`, and keep `publishConfig`
   free of provenance settings (npm infers it; Bun rejects it).
2. Bootstrap once from a maintainer machine with 2FA (`bun pm pack` then
   `npm publish --access public ./hazeion-fleur-0.1.0.tgz`, or a staged
   publish), then add the trusted publisher: user `hazeion`, repo `fleur`,
   workflow `release.yml`, environment `npm`; set "Require two-factor
   authentication and disallow tokens"; decide between allowing direct
   `npm publish` or using `npm stage publish` + 2FA approval. Do this within 2
   days of the first tagged release.
3. `release.yml` on `push: tags: ['v*']`, one `ubuntu-24.04` publish job with
   `environment: npm` (tag pattern `v*`, optional required reviewer),
   `permissions: {contents: read, id-token: write, attestations: write}`:
   floor Bun via bootstrap.py, `bun install --frozen-lockfile --ignore-scripts`,
   `TARBALL=$(bun pm pack --quiet)`, `actions/attest` on the tarball, then
   `npm publish --access public "./$TARBALL"` with npm >= 11.5.1 (Node 24 via
   pinned `actions/setup-node`, or `bunx npm@<pinned>`), and a second job with
   `contents: write` that downloads the tarball artifact and creates the
   immutable release (draft, upload, publish). Compare the three digests in
   the job log.
4. Enable release immutability and a `v*` tag ruleset (restrict creation,
   update, deletion) before the first automated release.

## Open questions

- Whether npm will allow configuring a trusted publisher for a package that
  does not exist yet (docs route configuration through existing package
  settings; staged publishing creates a `0.0.0-stage` placeholder). Confirm at
  bootstrap time.
- Whether the `release` workflow should be exempt from the
  `pull_request`/scope/verification shape in `tests/ci/workflows.test.ts`, and
  how its Node/npm step is pinned under the "every job installs exactly the
  floor Bun" rule (the rule constrains Bun, not Node).
- Ruleset availability on a personal Free-plan public repository: the
  rulesets concept page mentions "GitHub Team and GitHub Enterprise plans";
  the plans page lists "Deployment protection rules for public repositories"
  under Free, so environment gating is confirmed, tag rulesets are not.
- Whether `bun pm pack` output is reproducible across machines and Bun
  releases (identical on two runs here); matters only if a verifier wants to
  rebuild rather than compare digests.
- Bun provenance/OIDC support (oven-sh/bun#15601) would remove the npm CLI
  dependency; no timeline.

[scopes]: https://docs.npmjs.com/about-scopes/
[scoped-public]: https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/
[tp]: https://docs.npmjs.com/trusted-publishers/
[ga]: https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
[stage]: https://docs.npmjs.com/staged-publishing
[tokens]: https://docs.npmjs.com/about-access-tokens/
[prov]: https://docs.npmjs.com/generating-provenance-statements/
[audit]: https://docs.npmjs.com/cli/v11/commands/npm-audit
[npm-publish]: https://docs.npmjs.com/cli/v11/commands/npm-publish
[npm-view]: https://docs.npmjs.com/cli/v11/commands/npm-view
[scripts]: https://docs.npmjs.com/cli/v11/using-npm/scripts
[oidc-js]: https://github.com/npm/cli/blob/latest/lib/utils/oidc.js
[publish-js]: https://github.com/npm/cli/blob/latest/workspaces/libnpmpublish/lib/publish.js
[bun-publish]: https://bun.sh/docs/cli/publish
[bun-pm]: https://bun.sh/docs/cli/pm
[bunx]: https://bun.sh/docs/cli/bunx
[bun-15601]: https://github.com/oven-sh/bun/issues/15601
[oidc-ref]: https://docs.github.com/en/actions/reference/security/oidc
[envs]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[rules]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
[events]: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
[attest]: https://github.com/actions/attest
[abp]: https://github.com/actions/attest-build-provenance
[attest-concept]: https://docs.github.com/en/actions/concepts/security/artifact-attestations
[digests]: https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/
[rest-assets]: https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28
[immutable]: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
[prevent]: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes
[verify-release]: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity
[gh-verify-asset]: https://cli.github.com/manual/gh_release_verify-asset
[gh-attest-verify]: https://cli.github.com/manual/gh_attestation_verify
[billing]: https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions
[runner-image]: https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
