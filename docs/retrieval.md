# External retrieval

A Fleur retrieval is a validated server operation that obtains external API
data through Fleur's network capability, separately from database queries and
mutations. Application code never receives a URL, socket, credential or
general network access. It names a declared destination; the trusted host
broker performs the request and enforces every limit.

## Declaring a retrieval

Declare the browser-safe contract in `shared/`, and the destination and handler
in `server/`. Types for the handler's input, the destination's response body
and the retrieval output are inferred from the same strict schemas.

```tsx
// shared/weather.ts
import { defineRetrieval, schema } from "fleur/schema";
export const forecast = defineRetrieval({
  name: "weather.forecast",
  input: schema.object({ city: schema.string().min(1).max(64) }),
  output: schema.object({ temperature: schema.safeInteger().nullable(), available: schema.boolean() }),
});

// server/weather.tsx
import { defineDestination, handleRetrieval, readRetrieval, registerPage, RetrievalError } from "fleur/server";
import { schema } from "fleur/schema";
import { forecast } from "../shared/weather";
export const weatherApi = defineDestination({
  name: "weather.api",
  origin: "https://api.weather.example",
  path: "/v1/forecast/:city",
  response: schema.object({ temperature: schema.safeInteger() }),
  headers: ["etag"],
  credential: "weather",
});
handleRetrieval(forecast, async ({ input, external }) => {
  try {
    const response = await external.get(weatherApi, { params: { city: input.city }, query: { units: "metric" } });
    return { temperature: response.body.temperature, available: true };
  } catch (error) {
    if (error instanceof RetrievalError) return { temperature: null, available: false };
    throw error;
  }
});
registerPage(weatherPage, { component: async ({ params }) => {
  const current = await readRetrieval(forecast, { city: params.city });
  return <p>{current.available ? `${current.temperature} degrees` : "Weather unavailable"}</p>;
} });
```

A destination binds one canonical origin (`scheme://host[:port]`, without
credentials, path, query or a trailing slash) and one path template. Each `:name`
parameter is exactly one encoded path segment; `.` and `..` are rejected. The
handler may add string query parameters. It cannot choose another origin, method,
path or request header. Only `GET` (`external.get`) and `HEAD` (`external.head`)
exist. `HEAD` returns the status and declared headers without a body.

The `response` schema selects public data. Only the fields it names reach the
handler, and they are validated before the handler sees them. `headers` names the
response headers the handler may read. Authorization, cookie and authentication
challenge headers can never be declared.

The handler receives `{ input, external, log }`. It has no database authority:
retrievals cannot read or write the database. Queries, mutations and other
retrievals cannot call `readRetrieval`, and the `external` capability stops
working once its own retrieval finishes. To save retrieved public data, pass it to
a mutation, which revalidates it and applies business rules; data returned
through the browser is never trusted merely because it came from the server.

## Reading and refreshing

`readRetrieval(contract, input)` is available only while rendering a server page.
Results and failures are cached per view, retrieval name and canonical input:

- The first load of a view, and any new input, retrieves.
- Database-driven rerenders after a committed mutation reuse the cached entry;
  they never contact the provider again.
- `refreshRetrieval(contract, input)` from `fleur/client` explicitly asks this
  view's server to retrieve again. It returns `{ status: "success" }` or
  `{ status: "error", error: { code } }`, then the server rerenders the regions
  that read it. The browser never contacts the destination.
- A new navigation or view has its own initial load. Nothing is cached across
  views, and no cache holds secrets.
- One view caches at most 20 distinct retrieval inputs; reading more fails with
  `QUERY_LIMIT` instead of evicting a cached entry.

In the reactive adapter a render never waits for an external request: it
reads cached entries, and missing ones are retrieved outside the render before
it reruns. A render that runs a retrieval inline (the internal
`ReadApplication.render` without a reactive view) treats it like a nested
query. The retrieval's deadline is capped by the render deadline, so its slot
waits and outbound request end by their own deadlines before the render stops
waiting. As defence in depth, the render's abandonment also aborts them,
closing any open connection. Each handler run needs an execution slot, so a
nested retrieval waiting for a slot counts toward the nested fail-fast
described in [reactivity](reactivity.md): once every slot holds a render whose
nested query or retrieval waits for a slot, they fail at once with
`QUERY_LIMIT`. Outbound requests hold no slot and are not counted. A nested
retrieval still waiting for a slot at the render deadline fails with either
`QUERY_TIMEOUT` or `RETRIEVAL_TIMEOUT`, whichever deadline is observed first.

A cached failure stays a failure: it is never presented as empty data. An
unhandled failure marks the reading server region with its code and leaves
healthy sibling regions intact. Catch `RetrievalError` in the handler or the
page component to render a fallback explicitly.

## Failures

| Code | Meaning |
| --- | --- |
| `RETRIEVAL_DESTINATION_DENIED` | Undeclared destination or request, plain HTTP outside a local exception, or a denied address. |
| `RETRIEVAL_REDIRECT_DENIED` | The provider redirected. Redirects are never followed; `status` holds the 3xx code. |
| `RETRIEVAL_TIMEOUT` | The whole-operation deadline expired. |
| `QUERY_TIMEOUT` | One handler run exceeded the five-second worker operation deadline, for example CPU-bound work, while at least 500 ms of the retrieval deadline remained. |
| `RETRIEVAL_HTTP_FAILURE` | A non-2xx, non-redirect response; `status` holds the code. |
| `RETRIEVAL_TRANSPORT_FAILURE` | DNS, connection or TLS failure, including certificate or hostname verification. |
| `RETRIEVAL_TOO_LARGE` | The decoded body exceeded the limit, or the selected data exceeded 1 MiB. |
| `RETRIEVAL_INVALID_OUTPUT` | Non-JSON or schema-mismatched response data, or handler output that fails the contract. |

Failures carry no URL, header, body or secret; `RetrievalError.status` is the
only detail.

The broker shares one deadline between the external request and the handler.
Each external request ends early enough to leave a reserve so the handler can
still run, catch `RETRIEVAL_TIMEOUT` and return a fallback. The reserve is a
quarter of the time remaining when the retrieval starts, at most two seconds
and at least 750 ms: the 500 ms a handler run needs to start plus a 250-ms
margin. For a nested retrieval that remaining time is what is left of the
render. The reserve also covers the rerun as the run that asked for the
request measured it: that run's slot wait plus the larger of 500 ms and its
execution, plus 250 ms. A slow or loaded host therefore still leaves the rerun
time to start. When no more than the reserve remains, no request is made and
the handler sees `RETRIEVAL_TIMEOUT` at once. An unhandled timeout fails the
retrieval within the whole-operation deadline.

## Enforcement

The trusted host broker resolves the destination's hostname once, rejects the
request if any answer is loopback, private, link-local, metadata or otherwise
reserved, and connects to the admitted address with the declared `Host` and TLS
server name. The hostname is never resolved again, so DNS rebinding cannot move
the connection. HTTPS certificates are verified against the declared hostname.
Proxy environment variables such as `HTTP_PROXY` and `HTTPS_PROXY` are ignored:
no proxy selects the peer or receives a credential.

One deadline covers worker queueing, handler execution, DNS, connection, headers
and body. Decoded body bytes are counted while streaming, before parsing;
`Content-Length` is checked but not trusted. Compressed responses count their
decoded size. The defaults are 10 seconds and 1 MiB. Trusted server configuration
may raise them to at most 30 seconds and 10 MiB. Browser input cannot change them.
The selected data passed to application code is always bounded to 1 MiB.

Handlers run in fresh isolated application workers with no network access.
Direct network APIs such as `fetch` fail inside the worker: the native
restrictions deny socket, thread and event-object creation, so the worker
terminates (`INTERNAL_FAILURE`), or on some kernels stops only at its operation
deadline (`QUERY_TIMEOUT`). No request leaves the worker either way. A
worker run that requests a new destination response ends there; the broker
performs the request outside the five-second worker deadline, and a fresh worker
replays the handler with the recorded response. A run that requests nothing new
returns the result. Keep the sequence of requests a handler makes deterministic
for its input. One retrieval operation may make at most 20 distinct requests.

## Trusted configuration

Credentials, local-service exceptions and limits are host configuration supplied
at startup, never application source:

- `credentials` maps a binding name to an origin, a request header or query
  parameter, and the secret value. By default the broker reads them at startup
  from the `FLEUR_RETRIEVAL_CREDENTIALS` environment variable, a JSON object such
  as `{"weather":{"origin":"https://api.weather.example","header":"authorization","value":"Bearer ..."}}`.
  A destination naming the binding receives the secret only if its origin is
  exactly the bound origin. A declared binding that is not configured fails
  startup with `CONFIGURATION_MISSING`; a binding for a different origin, or a
  destination declaring the binding's own header as readable, fails with
  `CONFIGURATION_INVALID`. Handlers cannot read the secret or set the reserved
  query parameter. A response whose body or declared header echoes the secret is
  rejected as `RETRIEVAL_INVALID_OUTPUT`. Only literal and JSON-escaped copies are
  detected; an encoded copy, such as base64, is not.
- `localServices` lists exact local development or test origins. Only these may
  use plain HTTP, and only they may reach loopback or private addresses.
  Link-local and metadata addresses are never admitted.
- `timeoutMs` and `maxBytes` raise or lower the limits within the maximums above.

The internal adapter accepts this configuration through
`ReadApplication.open(images, url, maintenance, retrieval)`; explicit
`credentials` replace the environment bindings. A binding with unknown fields,
or a repeated binding name or field, fails startup with `CONFIGURATION_INVALID`.
Application workers never receive the host environment, and the host strips
retrieval credential variables from the Docker client and other child processes
it starts. The development and
production lifecycle commands that will read it from the startup environment are
later slices. `tests/runtime/fixtures/retrieval` demonstrates the contract.
