# Server rendering and capability foundations

Research for [Research server-default rendering and external retrieval foundations](https://github.com/hazeion/fleur/issues/19), 2026-10-13. Planning only. Documentation and source reads were performed; no packages, runtime prototypes, browser checks, database tests, or compatibility tests were run.

## Findings and recommendation

The human selected Bun plus Preact server rendering with explicit client islands in the follow-up discussion for #21. Retain Fleur-owned routing and validated operation dispatch; React RSC is comparative evidence, not the chosen foundation. Docker is approved for production isolation. No adapter has been verified against Fleur's reactive contracts, restricted application surface or production packaging.

The runtime capability boundary remains an executable feasibility gate. Rendering integration, import checks and browser bundle separation do not prevent ambient server network/filesystem access. The approved workflow does not permit unrestricted host alteration. The restricted-worker design below is a concrete proposal, not proof that Bun can run with its final policy.

## Rendering candidates

| Candidate | Primary evidence | Fleur integration gap |
| --- | --- | --- |
| Preact renderer and an islands adapter | [Preact SSR](https://preactjs.com/guide/v10/server-side-rendering/) documents string, async and streaming rendering. [Fresh architecture](https://usefresh.dev/docs/concepts/architecture) renders pages on the server and hydrates only islands. [Fresh data fetching](https://usefresh.dev/docs/concepts/data-fetching#async-page-components) supports async page components. | Fresh is a Deno-oriented framework, not evidence of a Bun-compatible Fleur adapter. Arbitrary nested async components, incremental server-subtree updates, state-preserving island replacement and callable-function admission need concrete design and tests. |
| React plus Vite RSC adapter | [React RSC](https://react.dev/reference/rsc/server-components) supports async server components composed with interactive clients, without shipping server implementations. React recommends exact integration pins because bundler APIs may change across minors. | Fleur must own validation, public operation registration, query tracking, routing and reload behavior. React serialization is not Fleur's validated JSON contract. |
| React Router RSC internally | [React Router](https://reactrouter.com/how-to/react-server-components) supplies SSR/component/function templates but labels Router RSC APIs unstable and its Vite RSC dependency experimental. | Adopting route/action conventions could duplicate Fleur contracts. It adds another integration to pin; do not expose it as an unrestricted application surface. |

[Vite's RSC plugin README](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-rsc/README.md) supplies separate RSC, SSR and browser environments, stream codecs, client refetching, server-function callbacks and default build-time `server-only`/`client-only` validation. Its APIs are low-level and framework-agnostic. The example separates Flight decoding from HTML rendering and browser hydration. Its `rsc:update` event describes source changes, not committed database changes. No Bun compatibility claim was found there. [Bun's Vite guide](https://bun.com/guides/ecosystem/vite) establishes ordinary Bun/Vite execution, not compatibility with that RSC integration.

Initial HTML rendering, hydration and reactive query refresh must be distinguished. A query's first result is not hydration. [Preact hydrate](https://preactjs.com/guide/v10/api-reference/#hydrate) attaches browser behavior to existing rendered HTML. Server default means application code stays on the server unless admitted into the client graph; SSR alone does not guarantee that exclusion.

## Fleur-owned contracts and proposed authoring

Preserve #4/#6's inferred validated operation contracts. Server components read through the same registered query authority; rendering never acquires write authority. Client calls resolve only registered Fleur operations, with input validation before execution and mutation output validation before commit. Do not make every `use server` export automatically browser-callable. RSC's richer values must not expand public operation payloads beyond Fleur's approved encodings.

Illustrative proposal, not existing or approved signatures:

```tsx
// Server-only application component
import { readQuery } from "fleur/server";
import { listExercises } from "../shared/contracts";

export async function ExerciseList() {
  const exercises = await readQuery(listExercises, {});
  return <ul>{exercises.map(exercise => <li key={exercise.id}>{exercise.name}</li>)}</ul>;
}
```

`readQuery` would register the operation and arguments in the render's query dependency set. Its result must pass the approved output schema before rendering/public delivery. The human selected a snapshot per query, without page-wide atomicity; multiple component queries may observe different commits. Client interaction keeps the existing inferred `fleur/client` mutation contract. Concrete frontend imports and island declaration signatures must be assembled without changing the selected model.

## Reactive server content and durable catch-up

Proposed mechanism: each committed managed mutation advances a durable database revision in the same transaction. Notifications wake refresh work; periodic revision probes detect missed wakeups. A database epoch changes after reset/restore and other state replacement. Active views track epoch/revision, navigation identity, connection generation and render request sequence. Reject obsolete results; failed refreshes retain explicitly stale content. Reconnect performs authoritative refresh before reporting current data. This is a design proposal derived from #8, not an upstream guarantee.

[PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) delivers notifications after commit, can fold identical notifications within a transaction, and describes listeners connected to the database. It is not a durable replay log for disconnected clients. A durable revision plus probing avoids treating a healthy connection or a notification count as proof of currency.

Initial render must capture its database revision and close the subscribe-after-render race through an authoritative revision check. Server content refresh must preserve stable interactive component identity, local drafts and focus, as the human confirmed. Query errors must remain isolated; a whole-page rerender cannot silently turn one failing query into failure of unrelated subscriptions. #17's freshness budgets constrain probing cadence and rerender cost.

Required tests: commit after initial read but before subscription; dropped publication without disconnect; out-of-order render responses; navigation during refresh; repeated notifications; mutation response lost after commit; failed query with healthy sibling; maintenance epoch change; draft preservation. No automatic mutation retry.

## Capability enforcement

Use three independent controls: a closed module graph admitted in dev/build, browser request/style policy, and a restricted server execution boundary with Fleur-owned brokers. Import restrictions must resolve transitive aliases, package subpaths, dynamic import, workers, remote/data modules and asset query suffixes rather than only scan direct import strings. Build output checks must inspect client chunks and maps for forbidden server content.

[CSP connect-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src) controls fetch, XHR, WebSocket and related connections. It can reject external browser requests while allowing Fleur transport, but cannot distinguish application fetch from Fleur fetch to the same allowed endpoint. Same-origin manual requests therefore need code admission/runtime instrumentation; CSP alone is insufficient. Presentation assets require separate image/media/font policies. External script and stylesheet loading remain rejected under #6.

Do not claim a Bun Worker or a JavaScript VM is a capability sandbox. [Bun Workers](https://bun.com/docs/runtime/workers) document execution APIs, not an authority-restricted application environment. [Node VM documentation](https://nodejs.org/api/vm.html) explicitly rejects using VM as a security mechanism. Removing globals in a shared trusted runtime is not sufficient evidence of runtime enforcement.

Selected direction: Linux application workers inside Docker, with a separate trusted broker retaining database/API credentials. [Docker run controls](https://docs.docker.com/engine/containers/run/) provide network isolation and filesystem/resource controls. Production Docker is now approved; this supersedes the earlier Bun-plus-PostgreSQL-only prerequisite expectation.

Concrete enforcement candidate: a trusted native bootstrap loads Bun and the admitted application bundle, creates a dedicated IPC channel, closes every unrelated descriptor, and applies a deny-after-load syscall policy before any application module evaluation or handler/component execution. No database, API secrets or host mounts enter the worker. The broker admits typed operation identifiers and structured database requests, never SQL text, arbitrary URLs, filesystem paths or transaction commit requests. It binds database requests to the current query/mutation authority and rejects writes under query authority.

[Docker seccomp documentation](https://docs.docker.com/engine/security/seccomp/) supports custom syscall profiles but describes its default profile as moderately protective, not a denial of ordinary filesystem/network operations. [Linux seccomp](https://man7.org/linux/man-pages/man2/seccomp.2.html) supports filter mode, argument inspection and synchronization across threads. A proposed final policy denies file opening/path mutation, creation/connection of network sockets, process execution and escape primitives, allowing only runtime-required memory/thread/event operations and IPC on admitted descriptors. Block syscall alternatives, inherited descriptors, FFI loading, worker spawning and io_uring bypasses. A read-only root alone still permits reads and does not satisfy the no-filesystem-access contract. [Landlock rulesets](https://man7.org/linux/man-pages/man2/landlock_create_ruleset.2.html) are a possible additional filesystem layer, subject to kernel feature detection.

Untested feasibility: Bun may lazily open runtime/module/timezone files, start threads or require syscalls after bootstrap. Installing the final filter must cover all existing and future threads, and no untrusted top-level initialization may run before it. Failure to install/synchronize policy blocks application execution. A native loader/embedding bridge may be required; no working Bun integration was established. Strict seccomp mode is not proposed because its tiny syscall set is insufficient evidence of Bun compatibility. The final specification must not advertise a completed isolation guarantee until a disposable compatibility probe and negative syscall/broker tests pass. If Bun cannot operate under the required policy, return to the human for an evaluator/runtime-boundary change; do not silently weaken enforcement.

## External retrieval proposal and choices

Fleur's broker owns credentials and the network client. Application code names a declared destination/operation, supplies validated inputs, and receives validated data or typed failure. Database mutations cannot call the retrieval broker. Do not pass database credentials into rendering code merely because it executes server-side.

Human-confirmed policy, with implementation details requiring verification:

- HTTPS destinations bind scheme, hostname, port, allowed method/path pattern and credential attachment. Disallow URL credentials and unchecked caller-selected origins. Retrieval uses GET/HEAD only.
- Redirects are disabled. [Fetch redirect algorithms](https://fetch.spec.whatwg.org/#http-redirect-fetch) show why validating only the initial URL would be insufficient if redirect support were added.
- Reject loopback/private/link-local destinations by default, including addresses obtained through DNS. Explicit local-service declarations bind exact targets. DNS rebinding, connection-address validation and redirects require an enforceable broker implementation, not hostname string checks alone.
- Bound the entire operation deadline and actual streamed/decompressed bytes; Content-Length alone cannot establish size. Abort oversized/late responses before validation. #17 approved defaults of 10 seconds and 1 MiB, with maximum configurable ceilings of 30 seconds and 10 MiB. Four concurrent retrievals per project remains a proposal requiring final resolution; no benchmark was executed.
- Distinguish destination rejection, timeout, transport failure, HTTP failure, oversized response and invalid response. Redact credentials/request headers; failed retrieval never becomes successful empty data. Cache by operation and validated inputs; refresh on initial load or explicit request only. Database invalidation must reuse that cached external result rather than refetch the provider.

## Remaining choices and verification obligations

1. Assemble exact Preact frontend imports/island declaration signatures for the selected server-default model.
2. Prove the restricted Linux worker policy is compatible with Bun and effective before application evaluation. Define and test broker authority for rendering, query snapshots and mutation transactions.
3. Finalize external concurrency and test approved GET/HEAD, redirect denial, resolved-address/local-service checks, caching and #17 limits.
4. Verify the approved per-query snapshot and draft/focus-preserving refresh semantics.
5. Pin compatible Bun, Vite, renderer/plugin/codec, validation/transport/database packages. Record exact tested versions rather than use floating latest or claim compatibility from ordinary Vite support.
6. Execute #11's positive/negative inference, server-bundle exclusion, runtime bypass, production artifact, PostgreSQL and two-view browser tests before compatibility is claimed. Include #17 workloads and gap recovery timing.

The product choices above are settled through live discussion. Isolation feasibility and adapter compatibility remain unverified. This report supplies a concrete direction and required gates, not an executed compatibility result.
