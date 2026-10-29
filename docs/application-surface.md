# Application source and presentation

Fleur admits one source snapshot before compiling its browser and restricted
worker bundles. The declaration commands use the same gate. Development lifecycle
and production `build`/`start` commands remain later slices; this does not make
those commands available.

Use `client/` for islands, `shared/` for browser-safe contracts and `server/` for
server declarations and handlers. Seed declarations have server authority.
Only the documented `fleur/*` entry points, `preact`, `preact/hooks` and the
compiler-owned Preact JSX runtime are admitted. Client and shared modules cannot
import server modules, `fleur/server` or `fleur/database`. Re-exports, type imports
and statically named dynamic imports receive the same checks.

Local aliases come from `compilerOptions.paths` in the project's JSON
`tsconfig.json`, with an optional `baseUrl` of `"."`. Exact and single-wildcard
aliases must resolve to admitted local files. Inherited configurations,
replacement aliases for Fleur/Preact, arbitrary package subpaths and executable
configuration are not admitted. Source and asset symlinks are refused.

Statically named lazy island modules are registered before application execution.
Their exports pass through the same worker manifest and browser hydration checks
as ordinary imports. Nested island props are validated against strict public
schemas before serialization. A server import does not put its server code or
configuration into the browser bundle or source maps.

Do not use ambient network, filesystem or process APIs, runtime-selected imports,
remote/data/blob code, dynamic code constructors or workers. Browser data comes
through Fleur queries, mutations and retrievals. Calling an allowed Fleur URL
with a manual browser transport is still refused. The browser installs runtime
transport and DOM guards before application modules evaluate; CSP separately
restricts executable resources. Neither layer replaces source admission.
Keep ambient browser objects in statically named property access; passing or
returning the window, document, navigator or reflection object is not admitted.

## Styling

Use complete Tailwind utility strings, including variants and arbitrary values.
Selecting between complete strings is supported. Assembling fragments does not
make Tailwind generate the missing class. Fleur compiles the release-owned
Tailwind 4.3.3 theme from presentation values in the admitted source snapshot,
without loading application configuration, plugins or stylesheets. It follows
JSX `class`/`className` values and Preact props through lexical constants, local
imports, conditional results and helper returns. Unrelated server strings and
branch conditions never become stylesheet input. Runtime data cannot introduce
new utilities that have no complete string in those presentation expressions.
Static array projection is limited to 128 alternatives and 2,000 elements.
Fleur collects these values without executing application code.

Sorting an array used for classes requires statically resolvable ordering.
Default sorting, explicit `undefined` and supported pure comparators such as
`() => 0` work. A comparator must use identifier parameters and an expression
body or a single reachable return expression whose comparisons resolve to
primitive values. Runtime-selected comparators and unresolved results are
refused with `UNRESOLVED_CLASS_SORT`. Select complete classes explicitly or use
a statically resolvable pure comparator to repair the refusal.

Dynamic JSX inline style values and custom properties work:

```tsx
<div
  class={wide ? "w-[123px] hover:text-red-500" : "w-[47px]"}
  style={{ "--accent": selected ? "blue" : "red", color: "var(--accent)" }}
/>
```

Application CSS files/modules, style elements, stylesheet links, CSSOM rule
injection and authored `@theme`, `@utility` or `@apply` stylesheets are refused.
Do not use HTML serialization as a styling API. Fleur's generated stylesheet
and inline style attributes have separate CSP permissions.

## Presentation assets

Place inert files under `assets/`. Refer to them through a local import or an
`/assets/...` URL. HTTPS image, font, audio and video URLs are allowed. External
fonts use font files, without a provider stylesheet. FontFace source descriptors
may name local or HTTPS font URLs.

Local assets are checked before either compiler can use them. The supported
formats are PNG, JPEG, GIF, WebP, AVIF, ICO, WOFF, WOFF2, TTF, OTF, MP3, WAV, OGG,
FLAC, M4A, MP4, WebM, OGV and inert SVG. SVG admits geometry, text, gradients,
masks and fragment references, but refuses entities, styles, events, animation,
external references and foreign HTML. Renaming HTML or JavaScript to a media
suffix does not admit it. Asset query suffixes such as `?raw` are not imports.

File names use ASCII letters, numbers, dots, underscores and hyphens. Asset
admission allows at most 500 files, 64 MiB per file and 128 MiB in total. Builds
serve the captured bytes even if the source files subsequently change. Stable
asset URLs require revalidation; generated code and CSS have content hashes.

## Refusals and verification

`SOURCE_REJECTED` exits with category 1. Source diagnostics provide a safe
relative location, a rule code and a repair action, without quoting source,
credentials or machine paths. Fix the source and rerun the original command;
source refusals do not require database recovery.

The focused checks are `surface-admission.test.ts`, `presentation-build.test.ts`,
`browser-surface.test.ts` and `surface-worker.integration.test.ts` under
`tests/runtime/`. They exercise aliases, forbidden imports and transports,
snapshot builds, malicious assets, Tailwind and live inline styles, independent
runtime/CSP controls, reactive HTML refusal and native lazy-island registration.
The regular type, lint, reference-build and full-suite gates remain required.
