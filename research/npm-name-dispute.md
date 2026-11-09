# npm name dispute process for the abandoned `fleur` package

Research ticket: hazeion/fleur#175 (map: #160). Date: 2026-11-09.

## Question

The unscoped npm name `fleur` is held by a package last published in 2015. What is npm's current dispute and name-transfer policy for abandoned packages, what are the exact steps and timelines, what counts as a good-faith contact attempt, what could disqualify the request, and what happens to existing dependents if the name transfers?

## Summary answer

There is no longer any npm process for claiming an abandoned package name. As of 2025-12-09 npm replaced its "Dispute Resolution" policy with a "Username Policy" that defers to GitHub's Username and Trademark policies, and on 2026-04-20 it added: "npm does not resolve squatting claims on demand. We do not transfer package, organization, or username ownership simply because another user wants the name. ... the formal name dispute process on GitHub ... is the only path we act on." That process is GitHub's Trademark Policy, which requires a federal or international trademark registration number. Inactivity was already excluded as grounds in every policy version since 2021. The former `support.github.com/contact/npm-name-disputes` form now redirects (HTTP 301) to the trademark-report form.

`fleur` is also not "squatted" under npm's definition (a package with "no genuine function"): it is a working 2015 Flux library with two versions, 16 downloads in the last month and three registry dependents (all bulk aggregator packages).

So for Fleur the realistic routes are:

1. A voluntary transfer by the current maintainer (Lim Yuan Qing, npm user `yuanqing`; the contact address is shown by `npm view fleur maintainers`) via `npm owner add`; no npm involvement, no published timeline, and no money may change hands (Open Source Terms, Acceptable Use 7).
2. A trademark complaint, only if Fleur owns a registered mark covering the goods; a same-name package is "not, by itself, necessarily a violation".
3. Publishing under a different unscoped name or under a scope Fleur controls. The `@fleur` scope is already taken by an unrelated project (`@fleur/fleur` 3.1.0, 2022).

Existing published versions are immutable in every scenario; a transfer changes only who may publish next, so dependents keep resolving `fleur@0.0.1` unchanged.

## Findings

### 1. The current policy: "Username Policy" (docs.npmjs.com/policies/disputes)

The page at <https://docs.npmjs.com/policies/disputes> is now titled "Username Policy". Its source is `content/policies/disputes.mdx` in <https://github.com/npm/documentation>. Verbatim from the current source (fetched 2026-11-09):

> npm follows GitHub's Username Policy. This means that usernames, organization names, and package names are available on a first-come, first-served basis, and are intended for immediate and active use.

> **npm does not resolve squatting claims on demand.** We do not transfer package, organization, or username ownership simply because another user wants the name. If you believe a name infringes a trademark or other intellectual property right you own, please follow the formal name dispute process on GitHub - that is the only path we act on.

The "name dispute process on GitHub" link targets <https://docs.github.com/en/site-policy/content-removal-policies/github-trademark-policy>.

Squatting definitions retained from the older policy:

> Package names are considered squatted if the package has no genuine function.

> Organization names are considered squatted if there are no packages published within a reasonable time. ... a paid organization will never be considered squatted.

> We are extremely unlikely to transfer control of a username ...

Trademark section:

> npm processes Trademark claims under GitHub's Trademark Policy. If you think another npm publisher is infringing your trademark, such as by using a confusingly similar package, org, or user account name, please submit a Trademark Policy Violation Report via our form (<https://support.github.com/contact/trademark-policy>).

### 2. How and when the policy changed (npm/documentation git history)

Commit history of `content/policies/disputes.mdx` (via `gh api repos/npm/documentation/commits?path=...`):

| Date | Commit / PR | Change |
| --- | --- | --- |
| 2021-07-16 | 89de7b8c | Policy pages added to this repo. |
| 2021-09-14 | d121d3d8 | Already states: "We are not currently accepting dispute requests to 'adopt an abandoned package' or 'Report Squatting' as we re-evaluate and update the overall dispute process." |
| 2022-03-24 to 2022-08-03 | cdfc28ea ... 546a4b5a | Rewritten around a GitHub support form at `support.github.com/contact/npm-name-disputes`. Text (still present at 2023-10-23, c62df531): "This process is not available for dispute requests due to lack of activity related to a specific name." and "there are cases where a party may have claim to a specific name, but giving that name to the requesting party would pose a supply-chain risk to the npm ecosystem. In such cases, requests may be denied independent of the validity of the claim." |
| 2025-12-09 | 0e03658b, PR [#1809](https://github.com/npm/documentation/pull/1809) by literarytea, merged by leobalter | "Update and rename disputes policy to align with GitHub's Username Policy". PR body: "GitHub has updated its trademark policy to accommodate npm reports. Therefore, we're updating npm's dispute policy to align fully with GitHub's Username and Trademark policies." Form link to `npm-name-disputes` removed. |
| 2026-04-20 | e93dc35f, PR [#1944](https://github.com/npm/documentation/pull/1944) by leobalter | "Update squatting policy details in disputes.mdx". Adds the bold "npm does not resolve squatting claims on demand" paragraph. |

Corroboration: `curl -I https://support.github.com/contact/npm-name-disputes` returns `301` to `https://support.github.com/contact/trademark-policy` (checked 2026-11-09). The dedicated name-dispute intake no longer exists.

The classic npm-era procedure (email the author, CC support, wait four weeks) that still circulates in `npm-disputes(7)` man pages from npm 5 and Debian is therefore two policy generations out of date and must not be relied on.

### 3. GitHub Username Policy (what npm now follows)

Source: <https://docs.github.com/en/site-policy/other-site-policies/github-username-policy> (raw: `content/site-policy/other-site-policies/github-username-policy.md` in github/docs).

> We do not accept requests to release, transfer, or reclaim usernames on the basis that they appear inactive or unused. If the username you want has already been claimed, you will need to select a different available name unless you are submitting a trademark complaint as described below.

> Valid trademark-related complaints are the only requests we review for possible release of a username that is already claimed.

> GitHub prohibits account name squatting, and account names may not be reserved or inactively held for future use. Accounts violating this name squatting policy may be removed or renamed without notice. Attempts to sell, buy, or solicit other forms of payment in exchange for account names are prohibited and may result in permanent account suspension.

### 4. GitHub Trademark Policy (the only adjudicated route)

Source: <https://docs.github.com/en/site-policy/content-removal-policies/github-trademark-policy> (raw: `content/site-policy/content-removal-policies/github-trademark-policy.md` in github/docs).

Prerequisite: "A federal or international trademark registration number is required." Unregistered names are accepted only from bodies such as government agencies or non-profits, with a company-domain email.

What is not a violation: "Using another's trademark in a way that has nothing to do with the product or service for which the trademark was granted is not a trademark policy violation. ... A GitHub account with a user name that happens to be the same as a registered trademark is not, by itself, necessarily a violation of our trademark policy."

Required contents of a report (form: <https://support.github.com/contact/trademark-policy>): reported username (for npm, the package/org/user name), company name, company GitHub account, website, the mark, registration number, registration office, description of confusion, requested action ("e.g., removal of violating account or transfer of trademarked username to an existing company account"), the good-faith statement, the perjury statement, and a signature.

Outcomes: with "clear intent to mislead", GitHub suspends the account; when an account "appears to be confusing users, but is not purposefully passing itself off", the holder gets a chance to clear up confusion and GitHub "may also release a username for the trademark holder's active use". No response-time commitment is published.

### 5. npm Open Source Terms and Code of Conduct

Source: <https://docs.npmjs.com/policies/open-source-terms> ("npm last updated these npm Open Source Terms on March 10, 2022"); raw `content/policies/open-source-terms.mdx`.

- "npm resolves disputes about package names, user names, and organization names in the Public Registry per the policy at https://docs.npmjs.com/disputes (Dispute Policy). This includes 'package squatting'."
- Acceptable Use 7: "You will not buy, sell, or otherwise trade in user names, organization names, names for Packages, or any other names reserved on npm Services, for money or other compensation." This forbids paying the current holder for `fleur`.
- Acceptable Content 5: "Content that exists only to 'reserve' a name, whether a package name, user name, or organization name. The Dispute Policy governs how npm handles such cases of 'squatting'."
- "Administrators at npm reserve the right to delete content hosted on the npm Services that they deem unacceptable."

Code of Conduct (<https://docs.npmjs.com/policies/conduct>, "Reporting Violations"): "If you think a package or other content is 'squatting' on a name, follow the process described in the Disputes Policy." That loop now terminates at the trademark form.

### 6. Is `fleur` squatted or abandoned under these definitions?

Registry facts (`npm view fleur --json`, 2026-11-09):

- Versions `0.0.0` (2015-11-16) and `0.0.1` (2015-11-18); `time.modified` 2022-06-18 with no new version, so the 2022 touch is a metadata change, not a publish.
- Maintainer `yuanqing` (email in the registry maintainer record), author "Lim Yuan Qing", MIT, `main: lib/index.js`, four runtime dependencies, a test script, description "Something like Flux, without the boilerplate."
- Repository <https://github.com/yuanqing/fleur>: archived, last push 2015-11-22, 0 stars (`gh api repos/yuanqing/fleur`). The owner's GitHub account is active (profile updated 2026-09-25, 148 public repos).
- Downloads (api.npmjs.org): 16 in the last month (2026-10-10 to 2026-11-08), 254 in the last year.
- Dependents (packages.ecosyste.ms, registry does not expose this directly): 3 packages, all bulk aggregators that depend on every package in the registry: `@infinitebrahmanuniverse/nolb-fle`, `@zalastax/nolb-fle`, `@everything-registry/sub-chunk-1680`; 1 dependent repository (`raikasdev/ultimate-package`, same genre).

Assessment: the package has a genuine function (a Flux store library), so it does not meet npm's squatting definition. It is abandoned in the everyday sense, but inactivity has been explicitly excluded as grounds since 2021 and npm now says it acts on no path other than trademark.

### 7. Voluntary transfer mechanics

Source: <https://docs.npmjs.com/transferring-a-package-from-a-user-account-to-another-user-account>.

- Owner runs `npm owner add <new-user> fleur` (or uses the package Admin tab, Maintainers, Invite); the invitee receives an email invitation and must accept; then the owner runs `npm owner rm yuanqing fleur`. With 2FA enforced for writes, the owner appends `--otp=<code>`.
- "You cannot transfer a scoped package to another user account or organization." Not relevant to unscoped `fleur`, but relevant if Fleur later wants a scope.
- No npm staff involvement or timeline; the transfer is complete when the invitation is accepted and the old owner removed. The recipient needs an npm account first.

### 8. What happens to dependents and existing versions

Sources: <https://docs.npmjs.com/policies/unpublish>, <https://docs.npmjs.com/unpublishing-packages-from-the-registry>, npm blog 2016-03-23 "kik, left-pad, and npm" (<https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm>).

- "Registry data is immutable, meaning once published, a package cannot change." A version number, once used, "cannot be reused by unpublishing and re-publishing it." After ownership changes, `fleur@0.0.0` and `fleur@0.0.1` still resolve to the same tarballs, so the three aggregator dependents are unaffected. A new owner's first publish must be a new version (for example `0.1.0` or `1.0.0`), and anything depending on `fleur@*` or `latest` would start receiving it.
- The current owner cannot unpublish the package under the policy: for packages older than 72 hours, unpublish requires that "no other packages in the npm Public Registry depend on it", fewer than 300 weekly downloads, and a single owner. The dependents condition fails. The docs recommend deprecation instead; a new owner may run `npm deprecate fleur@"<=0.0.1" "<message>"` to warn installers of the legacy versions.
- If a package with dependents is ever fully unpublished, npm (per the 2016 post) replaces it "with a placeholder package" that "prevents immediate adoption of that name", and republishing the same name is blocked for 24 hours. There is no scenario in which the `fleur` name becomes free for first-come registration.

### 9. Alternatives in the registry

Registry search (2026-11-09): the `@fleur` scope is held by an unrelated project (`@fleur/fleur` 3.1.0, `@fleur/react`, `@fleur/lys`, `@fleur/mordred` updated 2026-07). Scope names follow the same first-come rule, so `@fleur/*` is unavailable. A scope Fleur already controls, or a distinct unscoped name, needs no dispute. The package name guidelines (<https://docs.npmjs.com/package-name-guidelines>) ask that an unscoped name "is not spelled in a similar way to another package name" and "will not confuse others about authorship".

## Human checklist

Decide first whether the unscoped name is worth pursuing at all; the only guaranteed route is a different name or a Fleur-owned scope.

Route A: voluntary transfer (the realistic path)

1. Create the npm account (or org) that should own the package; enable 2FA.
2. Contact Lim Yuan Qing using the registry maintainer address (`npm view fleur maintainers`) and/or GitHub `yuanqing`. State the project, that `yuanqing/fleur` is archived, and ask them to run `npm owner add <your-npm-user> fleur`, then `npm owner rm yuanqing fleur` after you accept.
3. Do not offer money, services or any other compensation; Acceptable Use 7 forbids trading names "for money or other compensation" and GitHub's policy says such attempts "may result in permanent account suspension".
4. Accept the invitation email; confirm with `npm owner ls fleur`.
5. Publish a new version (`0.0.0` and `0.0.1` can never be reused). Optionally deprecate the legacy versions with a pointer to the new project. Do not unpublish them: policy forbids it while dependents exist, and it would not free the name anyway.
6. Set a deadline for a reply (for example four weeks, mirroring the old npm custom; there is no official waiting period). If no reply, fall back to Route C. Do not file an "abandoned package" request with npm support: the policy says inactivity is not grounds and npm acts only on the trademark path.

Route B: trademark complaint (only if Fleur holds a registered mark)

1. Confirm a federal or international registration for "Fleur" in a class that covers software/developer tools, and have the registration number and office.
2. Submit <https://support.github.com/contact/trademark-policy> from a company-domain email with all fields listed in Finding 4, including both sworn statements and a signature, and request transfer of the `fleur` package name to the Fleur npm account.
3. Expect that a same-name package in a different field is "not, by itself" a violation; the 2015 library is a JavaScript state-management package, so confusion with a developer tool is arguable but not assured. No response time is published.

Route C: no dispute

1. Pick a distinct unscoped name, or publish under a scope Fleur controls (`@fleur` is taken).
2. Record the decision in the naming tickets (#167, #164).

## Open questions

- Whether npm support still informally honours "adopt an abandoned package" requests despite the written policy. Only the documents were consulted; anecdotes were excluded. The documents say no.
- Whether Fleur wants or has a registered trademark; this research did not search any trademark register.
- Whether `yuanqing` will respond. The GitHub account is active (updated 2026-09-25); the npm package has not been published to since 2015.
- What the 2022-06-18 `modified` timestamp reflects (likely a registry-wide metadata change; it cannot be determined from `npm view`).

## Sources

- npm Username Policy: <https://docs.npmjs.com/policies/disputes>; source and history: <https://github.com/npm/documentation/commits/main/content/policies/disputes.mdx>; PRs <https://github.com/npm/documentation/pull/1809>, <https://github.com/npm/documentation/pull/1944>
- GitHub Username Policy: <https://docs.github.com/en/site-policy/other-site-policies/github-username-policy>
- GitHub Trademark Policy: <https://docs.github.com/en/site-policy/content-removal-policies/github-trademark-policy>; form <https://support.github.com/contact/trademark-policy>
- npm Open Source Terms: <https://docs.npmjs.com/policies/open-source-terms>
- npm Code of Conduct: <https://docs.npmjs.com/policies/conduct>
- npm Unpublish Policy: <https://docs.npmjs.com/policies/unpublish>; how-to: <https://docs.npmjs.com/unpublishing-packages-from-the-registry>
- Transferring a package: <https://docs.npmjs.com/transferring-a-package-from-a-user-account-to-another-user-account>
- Package name guidelines: <https://docs.npmjs.com/package-name-guidelines>
- npm blog, "kik, left-pad, and npm" (2016-03-23): <https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm>
- Registry data: `npm view fleur --json`; <https://api.npmjs.org/downloads/point/last-month/fleur>; <https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/fleur/dependent_packages>; `gh api repos/yuanqing/fleur`
